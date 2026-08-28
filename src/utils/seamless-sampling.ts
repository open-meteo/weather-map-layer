/**
 * Per-point sampling helpers for seamless composite domains.
 *
 * Seamless layers are ordered finest-first.  At any geographic point the finest
 * layer that covers it wins, smoothly blending into the next coarser layer
 * across each layer's `blendWidthDeg` edge zone (smooth-step 3d²−2d³).  This is
 * the same blend the raster path uses, factored out here so the vector layers
 * (arrows, contours, grid points) render continuously across domain boundaries
 * instead of cutting off at the finest layer's footprint.
 */
import type { GridInterface } from '../grids/interface';

import { degreesToRadians, radiansToDegrees } from './math';
import { computeNanDistanceField } from './nan-distance';

import type { InterpolationMethod, SeamlessLayerRenderData } from '../types';

export type ValueSampler = (lat: number, lon: number) => number;

export interface VectorSample {
	/** Magnitude (e.g. wind speed). */
	value: number;
	/** Direction in degrees, same convention as the source `directions` array. */
	direction: number;
}

export type VectorSampler = (lat: number, lon: number) => VectorSample;

// Worker-side cache of NaN-distance fields, keyed by `layer.nanFieldKey` (stable
// per data URL + ranges). Computed once per timestep/viewport and reused across
// tiles. A `null` entry records "computed, no field" so non-padded grids aren't
// rescanned on every tile.
const nanFieldCache = new Map<string, Float32Array | null>();
const MAX_NAN_FIELDS = 16;

const getNanField = (layer: SeamlessLayerRenderData): Float32Array | undefined => {
	const key = layer.nanFieldKey;
	if (!key) return undefined;
	if (nanFieldCache.has(key)) return nanFieldCache.get(key) ?? undefined;

	let field: Float32Array | undefined;
	const values = layer.data.values;
	const grid = layer.domain.grid;
	if (values && grid.type === 'regular') {
		const nx = layer.ranges[1].end - layer.ranges[1].start;
		const ny = layer.ranges[0].end - layer.ranges[0].start;
		field = computeNanDistanceField(values, nx, ny, grid.dx!, grid.dy!);
	}

	if (nanFieldCache.size >= MAX_NAN_FIELDS) {
		const oldest = nanFieldCache.keys().next().value;
		if (oldest !== undefined) nanFieldCache.delete(oldest);
	}
	nanFieldCache.set(key, field ?? null);
	return field;
};

/**
 * Smooth-step weight of `layer` at (lat, lon): 1 deep inside the layer, falling
 * to 0 at the edge of its blend zone.  Returns 1 when the layer does not blend
 * (global fallback / `blendWidthDeg <= 0`).
 *
 * The edge distance is the smaller of:
 *  - the distance to the domain boundary (`fullGrid.edgeDistanceDeg`), which is
 *    projection-aware so the band follows a curved boundary; and
 *  - the distance to the nearest NaN cell (`field`), so the band also follows the
 *    real data shape of NULL-padded regular grids.
 */
const edgeBlendWeight = (
	fullGrid: GridInterface,
	valueGrid: GridInterface,
	field: Float32Array | undefined,
	layer: SeamlessLayerRenderData,
	lat: number,
	lon: number
): number => {
	if (layer.blendWidthDeg <= 0) return 1;
	let dist = fullGrid.edgeDistanceDeg(lat, lon);
	if (field) {
		const nanDist = valueGrid.getLinearInterpolatedValue(field, lat, lon);
		if (isFinite(nanDist)) dist = Math.min(dist, nanDist);
	}
	const d = dist / layer.blendWidthDeg;
	if (d <= 0) return 0;
	if (d >= 1) return 1;
	return d * d * (3 - 2 * d); // smooth-step
};

/**
 * Recursively samples and blends a scalar field from seamless layers, starting
 * at `startIdx`.  Skips layers that do not cover the point (NaN) and blends with
 * the next coarser layer(s) inside the edge zone.
 */
const blendValue = (
	layerGrids: GridInterface[],
	edgeGrids: GridInterface[],
	fields: (Float32Array | undefined)[],
	seamlessLayers: SeamlessLayerRenderData[],
	lat: number,
	lon: number,
	startIdx: number,
	method: InterpolationMethod
): number => {
	for (let i = startIdx; i < seamlessLayers.length; i++) {
		const layer = seamlessLayers[i];
		const vals = layer.data.values;
		if (!vals) continue;

		const value = layerGrids[i].getInterpolatedValue(vals, lat, lon, method);
		if (!isFinite(value)) continue; // point not covered by this domain

		if (i === seamlessLayers.length - 1) return value;
		const t = edgeBlendWeight(edgeGrids[i], layerGrids[i], fields[i], layer, lat, lon);
		if (t >= 1) return value;

		const fallback = blendValue(
			layerGrids,
			edgeGrids,
			fields,
			seamlessLayers,
			lat,
			lon,
			i + 1,
			method
		);
		if (!isFinite(fallback)) return value;
		return value * t + fallback * (1 - t);
	}
	return NaN;
};

/**
 * Blends a scalar field across all seamless layers at (lat, lon).
 *
 * `layerGrids` index the (possibly viewport-cropped) data arrays; `edgeGrids` are
 * the full-domain grids used to measure the blend edge distance, so the blend
 * follows the real domain boundary rather than the tile/viewport crop. They
 * default to `layerGrids` for callers that pass full-domain grids for both.
 */
export const sampleBlendedValue = (
	layerGrids: GridInterface[],
	seamlessLayers: SeamlessLayerRenderData[],
	edgeGrids: GridInterface[] = layerGrids,
	method: InterpolationMethod = 'linear'
): ValueSampler => {
	const fields = seamlessLayers.map(getNanField);
	return (lat, lon) =>
		blendValue(layerGrids, edgeGrids, fields, seamlessLayers, lat, lon, 0, method);
};

/**
 * Recursively blends a wind vector across seamless layers.  Blending happens in
 * U/V component space so both magnitude and direction stay continuous across
 * domain seams (averaging raw bearings would wrap incorrectly near 0°/360°).
 */
const blendVector = (
	layerGrids: GridInterface[],
	edgeGrids: GridInterface[],
	fields: (Float32Array | undefined)[],
	seamlessLayers: SeamlessLayerRenderData[],
	lat: number,
	lon: number,
	startIdx: number,
	method: InterpolationMethod
): { u: number; v: number } | null => {
	for (let i = startIdx; i < seamlessLayers.length; i++) {
		const layer = seamlessLayers[i];
		const vals = layer.data.values;
		const dirs = layer.data.directions;
		if (!vals || !dirs) continue;

		// Sample the magnitude with the selected method so arrow size/colour
		// matches the raster; direction is blended circularly (scalar averaging
		// flips arrows near the 0°/360° seam).
		const speed = layerGrids[i].getInterpolatedValue(vals, lat, lon, method);
		if (!isFinite(speed)) continue; // point not covered by this domain

		const rad = degreesToRadians(layerGrids[i].getLinearInterpolatedDirection(dirs, lat, lon));
		const u = speed * Math.sin(rad);
		const v = speed * Math.cos(rad);

		if (i === seamlessLayers.length - 1) return { u, v };
		const t = edgeBlendWeight(edgeGrids[i], layerGrids[i], fields[i], layer, lat, lon);
		if (t >= 1) return { u, v };

		const fallback = blendVector(
			layerGrids,
			edgeGrids,
			fields,
			seamlessLayers,
			lat,
			lon,
			i + 1,
			method
		);
		if (!fallback) return { u, v };
		return { u: u * t + fallback.u * (1 - t), v: v * t + fallback.v * (1 - t) };
	}
	return null;
};

/** Blends a wind vector (magnitude + direction) across all seamless layers. */
export const sampleBlendedVector = (
	layerGrids: GridInterface[],
	seamlessLayers: SeamlessLayerRenderData[],
	edgeGrids: GridInterface[] = layerGrids,
	method: InterpolationMethod = 'linear'
): VectorSampler => {
	const fields = seamlessLayers.map(getNanField);
	return (lat, lon) => {
		const uv = blendVector(layerGrids, edgeGrids, fields, seamlessLayers, lat, lon, 0, method);
		if (!uv) return { value: NaN, direction: NaN };
		let direction = radiansToDegrees(Math.atan2(uv.u, uv.v));
		if (direction < 0) direction += 360;
		return { value: Math.hypot(uv.u, uv.v), direction };
	};
};
