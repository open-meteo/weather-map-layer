/**
 * GPU wind arrows for the custom layer: a hybrid of the two existing worlds.
 *
 * Sampling stays on the CPU — the same grid classes and (for seamless
 * composites) the same circular vector blend the tile workers use — but only
 * at the sparse anchor lattice, a few thousand points per viewport. The GPU
 * then draws one instanced arrow per anchor through the map's `projectTile`,
 * so arrows follow the globe, never pop in tile-by-tile, and morph (rotate,
 * grow, fade) in-shader together with the raster's temporal value blend: each
 * instance carries its previous and current state, mixed by the same u_mix.
 *
 * The shape and its speed ramps are the ones `generateArrows` bakes into
 * vector tiles: a shaft plus open V head in a unit box, pointing where the
 * flow goes (direction + 180°), length stepped by speed.
 */
import { tile2lat } from '../utils/math';

import type { ProjectionShaderData } from './shader-source';

/** Per speed threshold: stroke alpha and width, weakest first. */
export interface GpuArrowLevel {
	minSpeed: number;
	alpha: number;
	width: number;
}

/** Arrow pass configuration; colours/sizes resolved by the host app. */
export interface GpuArrowConfig {
	/** Screen pixels between anchors (at integer zoom). */
	spacingPx: number;
	/** Icon box size in screen pixels; shapes fill `arrowLength` of it. */
	sizePx: number;
	/** Stroke RGB 0..1 (plain black or white in practice). */
	color: [number, number, number];
	/** Speed ramp, sorted by minSpeed ascending. */
	levels: GpuArrowLevel[];
	/** Arrows fade in below this zoom and stay hidden 1 level under it. */
	minZoom?: number;
	/** Arrows fade out above this zoom. */
	maxZoom?: number;
}

export type ArrowSampler = (lat: number, lon: number) => { value: number; direction: number };

/** Head half-width and depth as fractions of the box (generateArrows' 13/22 of 100). */
export const ARROW_HEAD_HALF = 0.13;
export const ARROW_HEAD_DEPTH = 0.22;

/** Total arrow length per speed as a fraction of the box — generateArrows' ramp. */
export const arrowLengthFor = (speed: number): number => {
	if (speed < 1) return 0.5;
	if (speed < 2) return 0.55;
	if (speed < 3) return 0.6;
	if (speed < 5) return 0.7;
	if (speed < 10) return 0.75;
	if (speed < 20) return 0.8;
	return 0.85;
};

const levelFor = (levels: GpuArrowLevel[], speed: number): GpuArrowLevel => {
	let level = levels[0];
	for (const candidate of levels) if (speed > candidate.minSpeed) level = candidate;
	return level;
};

export interface ArrowAnchors {
	/** Base-world mercator x,y pairs. */
	positions: Float64Array;
	count: number;
	/** Identity of the lattice, for rebuild checks. */
	key: string;
}

const MAX_ANCHORS = 12000;

/**
 * The anchor lattice for a viewport: spacing snapped to the *integer* zoom
 * level and aligned to the mercator origin, so anchors sit still while the
 * map zooms between levels and line up with the tile lattice of the CPU path
 * (the spacing divides a tile exactly).
 */
export const buildArrowAnchors = (
	view: { minX: number; minY: number; maxX: number; maxY: number },
	zoom: number,
	spacingPx: number,
	clipBounds?: [number, number, number, number],
	/** Polygon clip: anchors outside are dropped (createClippingTester). */
	insideClip?: (lon: number, lat: number) => boolean
): ArrowAnchors => {
	const zInt = Math.max(0, Math.round(zoom));
	// World pixels at the integer zoom (512px tiles).
	let spacing = spacingPx / (512 * Math.pow(2, zInt));
	// The world tiles draw much larger than nominal at the lowest zooms; densify
	// like the CPU lattice (generateWindPoints' z0/z1 multipliers).
	if (zInt === 0) spacing /= 2;
	else if (zInt === 1) spacing /= 1.55;

	const minY = Math.max(0, view.minY);
	const maxY = Math.min(1, view.maxY);
	let firstX = Math.floor(view.minX / spacing);
	let lastX = Math.ceil(view.maxX / spacing);
	// The lattice period rarely divides the world exactly, so generating columns
	// across more than one world would interleave two offset copies of the
	// lattice after wrapping (pairs and uneven gaps) — and the world-offset
	// draws already repeat the instances. Clamp to a single world of columns.
	const worldCols = Math.max(1, Math.floor(1 / spacing));
	if (lastX - firstX >= worldCols) {
		firstX = 0;
		lastX = worldCols - 1;
	}
	const firstY = Math.floor(minY / spacing);
	const lastY = Math.ceil(maxY / spacing);

	const cols = lastX - firstX + 1;
	const rows = lastY - firstY + 1;
	const capacity = Math.min(cols * rows, MAX_ANCHORS);
	const positions = new Float64Array(capacity * 2);
	let count = 0;

	outer: for (let row = firstY; row <= lastY; row++) {
		const y = row * spacing;
		if (y < 0 || y > 1) continue;
		const lat = tile2lat(y, 0);
		for (let col = firstX; col <= lastX; col++) {
			// Wrap into the base world; world copies re-draw the same instances.
			let x = (col * spacing) % 1;
			if (x < 0) x += 1;
			if (clipBounds || insideClip) {
				const lon = x * 360 - 180;
				if (
					clipBounds &&
					(lon < clipBounds[0] || lat < clipBounds[1] || lon > clipBounds[2] || lat > clipBounds[3])
				) {
					continue;
				}
				if (insideClip && !insideClip(lon, lat)) continue;
			}
			if (count >= capacity) break outer;
			positions[count * 2] = x;
			positions[count * 2 + 1] = y;
			count++;
		}
	}

	return {
		positions,
		count,
		key: `${zInt}|${spacing}|${firstX}|${lastX}|${firstY}|${lastY}|${clipBounds?.join(',') ?? ''}${insideClip ? '|p' : ''}`
	};
};

/**
 * Floats per arrow instance:
 * [0-1] anchor x,y · [2-5] prev sin,cos,halfLen,width · [6-9] cur ditto ·
 * [10-11] prev/cur alpha.
 */
export const ARROW_INSTANCE_FLOATS = 12;

/** Writes sin,cos,halfLen,width at `at`; returns the stroke alpha. */
const writeState = (
	out: Float32Array,
	at: number,
	sampler: ArrowSampler | undefined,
	lat: number,
	lon: number,
	levels: GpuArrowLevel[]
): number => {
	const sample = sampler?.(lat, lon);
	if (!sample || !isFinite(sample.value) || !isFinite(sample.direction)) {
		out[at] = 0;
		out[at + 1] = 1;
		out[at + 2] = 0;
		out[at + 3] = 0;
		return 0;
	}
	// Arrows point where the flow goes; the direction is where it comes from.
	const bearing = ((sample.direction + 180) * Math.PI) / 180;
	const level = levelFor(levels, sample.value);
	out[at] = Math.sin(bearing);
	out[at + 1] = Math.cos(bearing);
	out[at + 2] = arrowLengthFor(sample.value) / 2;
	out[at + 3] = level.width;
	return level.alpha;
};

/**
 * Sample both temporal states at every anchor into one instance array. With no
 * previous sampler the previous state equals the current (no morph). Missing
 * data carries alpha 0, so appearing/disappearing arrows fade with the blend.
 */
export const buildArrowInstances = (
	anchors: ArrowAnchors,
	current: ArrowSampler | undefined,
	previous: ArrowSampler | undefined,
	levels: GpuArrowLevel[]
): Float32Array => {
	const out = new Float32Array(anchors.count * ARROW_INSTANCE_FLOATS);
	for (let i = 0; i < anchors.count; i++) {
		const x = anchors.positions[i * 2];
		const y = anchors.positions[i * 2 + 1];
		const lon = x * 360 - 180;
		const lat = tile2lat(y, 0);
		const at = i * ARROW_INSTANCE_FLOATS;
		out[at] = x;
		out[at + 1] = y;
		out[at + 10] = writeState(out, at + 2, previous ?? current, lat, lon, levels);
		out[at + 11] = writeState(out, at + 6, current, lat, lon, levels);
	}
	return out;
};

/**
 * Template vertices: 3 stroked segments (shaft, both head strokes) as 2
 * triangles each — (segment id, end 0|1, side ±1) resolved in the shader,
 * where the geometry depends on the per-instance arrow length.
 */
// prettier-ignore
export const ARROW_TEMPLATE = new Float32Array((() => {
	const verts: number[] = [];
	for (let seg = 0; seg < 3; seg++) {
		// Two triangles of the segment quad: (A-,A+,B-) and (B-,A+,B+)
		verts.push(seg, 0, -1, seg, 0, 1, seg, 1, -1);
		verts.push(seg, 1, -1, seg, 0, 1, seg, 1, 1);
	}
	return verts;
})());

const ARROW_VERTEX_BODY = `
precision highp float;

in vec3 a_template; // segment id, end (0|1), side (±1)
in vec2 a_anchor;   // base-world mercator
in vec4 a_prev;     // sin, cos, halfLen (box fraction), width (px)
in vec4 a_cur;
in vec2 a_alpha;    // prev, cur

uniform float u_mix;
uniform float u_sizePx;
uniform vec2 u_viewport;
uniform float u_worldOffset;
// Screen pixels a MERC_STEP mercator-y step spans on flat mercator: the
// reference against which globe foreshortening is measured.
uniform float u_refStepPx;

out float v_dist;
out float v_halfWidth;
out float v_alpha;

const float HEAD_HALF = ${ARROW_HEAD_HALF};
const float HEAD_DEPTH = ${ARROW_HEAD_DEPTH};
const float MERC_STEP = 0.0005;

void main() {
	// Direction blends as a vector so the 0°/360° seam never spins the arrow.
	vec2 dirv = mix(a_prev.xy, a_cur.xy, u_mix);
	float dirLen = length(dirv);
	dirv = dirLen > 1e-6 ? dirv / dirLen : vec2(0.0, 1.0);
	float h = mix(a_prev.z, a_cur.z, u_mix);
	float w = mix(a_prev.w, a_cur.w, u_mix);
	v_alpha = mix(a_alpha.x, a_alpha.y, u_mix);

	// Segment endpoints in the unit box, y towards the arrow tip at +h.
	vec2 A, B = vec2(0.0, h);
	if (a_template.x < 0.5) {
		A = vec2(0.0, -h);
	} else if (a_template.x < 1.5) {
		A = vec2(-HEAD_HALF, h - HEAD_DEPTH);
	} else {
		A = vec2(HEAD_HALF, h - HEAD_DEPTH);
	}

	float halfW = 0.5 * w;
	float ext = halfW + 1.0; // 1px feather margin for anti-aliasing
	vec2 P = mix(A, B, a_template.y) * u_sizePx;
	vec2 seg = normalize(B - A);
	// Extend the ends by the half width so the three strokes meet at the tip.
	P += seg * (a_template.y * 2.0 - 1.0) * halfW;
	P += vec2(-seg.y, seg.x) * a_template.z * ext;

	// Rotate arrow space (y = flow bearing) into screen space (y down).
	float s = dirv.x;
	float c = dirv.y;
	vec2 screen = vec2(P.x * c + P.y * s, P.x * s - P.y * c);

	vec2 pos = vec2(a_anchor.x + u_worldOffset, a_anchor.y);
	vec4 clip = projectTile(pos);

	// Fade arrows out where the surface turns away from the camera (the globe's
	// limb): anchors compress in screen space there and would pile up. Probe a
	// small step on both mercator axes — the limb compresses along different
	// axes around the silhouette — and compare the shorter one against its
	// flat-mercator length.
	vec4 clipStepY = projectTile(vec2(pos.x, pos.y + MERC_STEP));
	vec4 clipStepX = projectTile(vec2(pos.x + MERC_STEP, pos.y));
	vec2 sA = clip.xy / max(clip.w, 1e-6) * u_viewport;
	vec2 sY = clipStepY.xy / max(clipStepY.w, 1e-6) * u_viewport;
	vec2 sX = clipStepX.xy / max(clipStepX.w, 1e-6) * u_viewport;
	// This doubles as a crowding measure: the globe draws the (mercator-uniform)
	// lattice cos(lat) denser towards the poles, where all columns converge.
	// The thresholds only bite below ~45% compression, so face-on mid-latitudes
	// keep full strength while the limb and the polar convergence fade out.
	float stepPx = min(length(sY - sA), length(sX - sA));
	float foreshorten = 0.5 * stepPx / max(u_refStepPx, 1e-3);
	v_alpha *= smoothstep(0.25, 0.5, min(foreshorten, 1.0));

	clip.xy += vec2(screen.x, -screen.y) * 2.0 / u_viewport * clip.w;
	gl_Position = clip;

	v_dist = a_template.z * ext;
	v_halfWidth = halfW;
}
`;

export const arrowVertexSource = (shaderData?: ProjectionShaderData): string => {
	if (shaderData) {
		return `#version 300 es
${shaderData.vertexShaderPrelude}
${shaderData.define}
${ARROW_VERTEX_BODY}`;
	}
	return `#version 300 es
precision highp float;

uniform mat4 u_matrix;

vec4 projectTile(vec2 pos) {
	return u_matrix * vec4(pos, 0.0, 1.0);
}
${ARROW_VERTEX_BODY}`;
};

export const ARROW_FRAGMENT_SOURCE = `#version 300 es
precision mediump float;

in float v_dist;
in float v_halfWidth;
in float v_alpha;

uniform vec3 u_color;
uniform float u_opacity;

out vec4 outColor;

void main() {
	float coverage = clamp(v_halfWidth + 1.0 - abs(v_dist), 0.0, 1.0);
	float a = v_alpha * coverage * u_opacity;
	outColor = vec4(u_color * a, a);
}
`;
