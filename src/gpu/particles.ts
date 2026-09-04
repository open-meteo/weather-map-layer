/**
 * GPU wind particle animation for the custom layer: thousands of particles
 * advect through the wind field and leave fading trails, the classic
 * "streamlines" view of a vector field.
 *
 * Everything runs on the GPU per frame:
 *
 * - **State** lives in a ping-pong pair of RGBA32F textures (mercator x, y,
 *   age). A fragment pass moves every particle along the local wind, ages it
 *   and respawns it (randomised lifetime, missing data, left the viewport).
 *   The wind is sampled with the *same generated grid samplers* as the raster
 *   fragment shader (`samplingSource`), so particles follow the exact field
 *   the raster shows — regular, projected and gaussian grids, and seamless
 *   composites with their smooth-step edge blend. On plain grids the pass
 *   also mixes previous/current timestep components by the raster's u_mix,
 *   so the flow morphs with the temporal blend instead of stepping.
 * - **Trails** are a ping-pong pair of viewport-sized RGBA8 framebuffers: each
 *   frame the previous trail image is copied over with a decay factor (the
 *   `floor(c*255*fade)/255` quantisation guarantees full decay to zero), then
 *   the particles are drawn on top as anti-aliased points through the map's
 *   `projectTile` — mercator, globe and the transition all work. The trail
 *   image is composited premultiplied onto the map.
 * - A camera change clears the trail history (screen-space trails cannot
 *   survive a reprojection) but keeps the particle positions — they are
 *   geographic, so the flow continues seamlessly once the camera settles.
 *
 * The wind *components* (u east, v north) are derived on the CPU from the
 * protocol's speed + direction arrays, cached per source array identity and
 * uploaded through the renderer's budgeted value-texture cache.
 */
import type { GpuGridUniforms } from './grid-uniforms';
import type { GpuDrawOptions, GpuProjectionData } from './renderer';
import { layerSpecOf, uploadGridLayerUniforms } from './renderer';
import { samplingSource, shaderKey } from './shader-source';
import type { ProjectionShaderData, SamplingShaderSpec } from './shader-source';

/** Particle pass configuration; colours/sizes resolved by the host app. */
export interface GpuParticleConfig {
	/** Particle count (rounded up to a square state texture). */
	count: number;
	/** Point diameter in CSS pixels. */
	sizePx: number;
	/** Particle RGB 0..1 (plain white or black in practice). */
	color: [number, number, number];
	/** Trail opacity 0..1 multiplied into the composite. @default 0.8 */
	opacity?: number;
	/** Screen speed in px/s per m/s of wind (zoom-independent). @default 1.4 */
	speedPxPerSec?: number;
	/** Trail persistence per frame at 60fps, 0..1. @default 0.96 */
	fadeOpacity?: number;
	/** Mean particle lifetime in seconds (randomised ±70%). @default 5 */
	maxAgeSec?: number;
	/** Particles fade in below this zoom and stay hidden 1 level under it. */
	minZoom?: number;
	/** Particles fade out above this zoom. */
	maxZoom?: number;
}

/** One wind-field layer of the update pass (seamless composites pass several). */
export interface ParticleFieldLayer {
	gridUniforms: GpuGridUniforms;
	/** Eastward / northward wind component textures (m/s, R32F). */
	uTexture: WebGLTexture;
	vTexture: WebGLTexture;
	/** Smooth-step blend zone width in degrees; <= 0 disables edge blending. */
	blendWidthDeg?: number;
	/** NaN-distance texture refining the blend edge (like the raster pass). */
	nanTexture?: WebGLTexture;
}

export interface ParticleRenderOptions {
	/** Finest-first, like the raster draw; a plain domain passes exactly one. */
	layers: ParticleFieldLayer[];
	/** Previous-timestep components of a single-layer field, mixed by `mix`. */
	prev?: { uTexture: WebGLTexture; vTexture: WebGLTexture };
	/** Temporal blend factor: 0 = previous, 1 = current. */
	mix: number;
	projection?: GpuDrawOptions['projection'];
	matrix?: ArrayLike<number>;
	config: GpuParticleConfig;
	/** Seconds since the previous update, clamped by the caller. */
	dtSeconds: number;
	/** Mercator displacement per (m/s) of wind over this update step. */
	mercPerMps: number;
	/** Respawn window in mercator coords (x0, y0, x1, y1); x span <= 1. */
	bounds: [number, number, number, number];
	/**
	 * Globe amount (the map's projection transition, 0 = flat mercator). On the
	 * globe the respawn distribution turns equal-area and the advection step is
	 * cos(lat)-compensated — a mercator-uniform lattice would pile slow-frozen
	 * particles onto the poles.
	 */
	globe: number;
	/** Composited trail opacity 0..1 (layer opacity, zoom fade included). */
	opacity: number;
	/** Point diameter in device pixels. */
	sizeDevicePx: number;
	/** Whole-world x offsets to draw (antimeridian copies). */
	worldOffsets: number[];
}

// ─── CPU wind components ─────────────────────────────────────────────────────

const windUVCache = new WeakMap<Float32Array, { u: Float32Array; v: Float32Array }>();

/**
 * Eastward/northward components from the protocol's speed + direction arrays
 * (direction = where the wind comes from, so the flow bearing is +180°).
 * Cached per values-array identity, like the renderer's texture cache.
 */
export const windComponentsOf = (
	values: Float32Array,
	directions: Float32Array
): { u: Float32Array; v: Float32Array } => {
	const cached = windUVCache.get(values);
	if (cached) return cached;
	const n = values.length;
	const u = new Float32Array(n);
	const v = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const speed = values[i];
		const direction = directions[i];
		if (!isFinite(speed) || !isFinite(direction)) {
			u[i] = NaN;
			v[i] = NaN;
			continue;
		}
		const bearing = ((direction + 180) * Math.PI) / 180;
		u[i] = speed * Math.sin(bearing);
		v[i] = speed * Math.cos(bearing);
	}
	const result = { u, v };
	windUVCache.set(values, result);
	return result;
};

// ─── Shaders ─────────────────────────────────────────────────────────────────

/** Fullscreen triangle via gl_VertexID; no buffers, works with an empty VAO. */
const FULLSCREEN_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
	vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	v_uv = p;
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FADE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_trail;
uniform float u_fade;
// Homography mapping current screen NDC to the previous frame's NDC: the
// mercator plane -> screen mapping is projective, so a camera move (pan, zoom,
// rotate, pitch) reprojects the trail history instead of discarding it.
uniform mat3 u_reproject;
out vec4 outColor;
void main() {
	vec3 p = u_reproject * vec3(v_uv * 2.0 - 1.0, 1.0);
	if (p.z <= 0.0) {
		outColor = vec4(0.0);
		return;
	}
	vec2 uv = (p.xy / p.z) * 0.5 + 0.5;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
		outColor = vec4(0.0);
		return;
	}
	// Quantised decay: a plain multiply stalls above zero in 8-bit rounding and
	// leaves permanent ghost trails; flooring guarantees every step decreases.
	outColor = floor(texture(u_trail, uv) * 255.0 * u_fade) / 255.0;
}
`;

const COMPOSITE_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_trail;
uniform float u_opacity;
out vec4 outColor;
void main() {
	// The trail accumulates premultiplied colour; scale both parts together.
	outColor = texture(u_trail, v_uv) * u_opacity;
}
`;

// ─── Globe trail reprojection (two-pass warp through mercator space) ─────────
//
// The globe's mercator -> screen mapping is not a homography, but the map's
// own `projectTile` prelude is available and its uniforms are plain values:
// evaluating it once with the PREVIOUS frame's values and once with the
// current ones reprojects the trail history exactly, for any projection
// variant (globe, mercator and the transition between them).
//
// Pass 1 (unwarp): a world mesh drawn flat over the mercator window; each
// vertex samples the previous trail image at the previous frame's screen
// position of its mercator point. Pass 2 (rewarp): the same mesh drawn
// through the current projectTile, sampling the mercator-space image and
// applying the trail decay.

/** Vertex shader body appended to the projection prelude for pass 1. */
const UNWARP_VERTEX_BODY = `
layout(location = 0) in vec2 a_uv;
// Mercator window of the intermediate texture: (x0, y0, x1, y1).
uniform vec4 u_window;
out vec4 v_prevClip;
void main() {
	vec2 merc = mix(u_window.xy, u_window.zw, a_uv);
	v_prevClip = projectTile(merc);
	gl_Position = vec4(a_uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

const UNWARP_FRAGMENT = `#version 300 es
precision highp float;
in vec4 v_prevClip;
uniform sampler2D u_trail;
out vec4 outColor;
void main() {
	// Behind the camera or beyond the far plane (the globe's back side is
	// pushed there by the prelude's clipping plane): no usable history.
	if (v_prevClip.w <= 0.0 || abs(v_prevClip.z) > v_prevClip.w) {
		outColor = vec4(0.0);
		return;
	}
	vec2 uv = (v_prevClip.xy / v_prevClip.w) * 0.5 + 0.5;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
		outColor = vec4(0.0);
		return;
	}
	outColor = texture(u_trail, uv);
}
`;

/** Vertex shader body appended to the projection prelude for pass 2. */
const REWARP_VERTEX_BODY = `
layout(location = 0) in vec2 a_uv;
uniform vec4 u_window;
out vec2 v_wuv;
void main() {
	vec2 merc = mix(u_window.xy, u_window.zw, a_uv);
	v_wuv = a_uv;
	gl_Position = projectTile(merc);
}
`;

const REWARP_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_wuv;
uniform sampler2D u_warp;
uniform float u_fade;
out vec4 outColor;
void main() {
	// Same quantised decay as the flat fade pass.
	outColor = floor(texture(u_warp, v_wuv) * 255.0 * u_fade) / 255.0;
}
`;

/** Subdivision of the warp mesh; the globe surface curves within the window. */
const WARP_MESH_N = 96;

/** Deep copy of a frame's projection uniforms (MapLibre reuses the arrays). */
interface ProjectionSnapshot {
	mainMatrix: Float32Array;
	fallbackMatrix: Float32Array;
	tileMercatorCoords: [number, number, number, number];
	clippingPlane: [number, number, number, number];
	projectionTransition: number;
}

const snapshotProjection = (p: GpuProjectionData): ProjectionSnapshot => ({
	mainMatrix: Float32Array.from(p.mainMatrix),
	fallbackMatrix: Float32Array.from(p.fallbackMatrix),
	tileMercatorCoords: [...p.tileMercatorCoords],
	clippingPlane: [...p.clippingPlane],
	projectionTransition: p.projectionTransition
});

const sameProjection = (a: ProjectionSnapshot, b: ProjectionSnapshot): boolean => {
	if (a.projectionTransition !== b.projectionTransition) return false;
	for (let i = 0; i < 16; i++) {
		if (a.mainMatrix[i] !== b.mainMatrix[i] || a.fallbackMatrix[i] !== b.fallbackMatrix[i]) {
			return false;
		}
	}
	for (let i = 0; i < 4; i++) {
		if (
			a.tileMercatorCoords[i] !== b.tileMercatorCoords[i] ||
			a.clippingPlane[i] !== b.clippingPlane[i]
		) {
			return false;
		}
	}
	return true;
};

/**
 * The update pass: one fragment per particle, sampling the wind components
 * through the generated grid samplers and writing the next state.
 */
export const updateFragmentSource = (spec: SamplingShaderSpec, temporal: boolean): string => {
	const layers = spec.layers;
	const decls = layers
		.map((_, i) => `uniform sampler2D u_u${i};\nuniform sampler2D u_v${i};`)
		.join('\n');
	const uArgs = layers.map((_, i) => `, u_u${i}`).join('');
	const vArgs = layers.map((_, i) => `, u_v${i}`).join('');

	const temporalChunk = temporal
		? `
	if (u_mix < 1.0) {
		float uPrev = blendedValue(lat, lon, u_uPrev0);
		float vPrev = blendedValue(lat, lon, u_vPrev0);
		if (!isMissing(u) && !isMissing(v) && !isMissing(uPrev) && !isMissing(vPrev)) {
			u = mix(uPrev, u, u_mix);
			v = mix(vPrev, v, u_mix);
		}
	}`
		: '';

	return `#version 300 es
precision highp float;
precision highp int;
${samplingSource(spec)}
${decls}
${temporal ? 'uniform sampler2D u_uPrev0;\nuniform sampler2D u_vPrev0;\nuniform float u_mix;' : ''}

uniform sampler2D u_state;
uniform float u_dt;        // seconds of this step
uniform uint u_frame;      // frame counter, fresh randomness per step
uniform float u_speedMerc; // mercator displacement per (m/s) this step
uniform float u_maxAge;    // mean lifetime in seconds
uniform vec4 u_bounds;     // respawn window (x0, y0, x1, y1); x0 may be negative
// Shed probability this step: when the window grows (zoom-out) the surplus
// redistributes immediately instead of lingering as a dense cluster of the
// old viewport. 1 - oldArea/newArea keeps the density per screen constant.
uniform float u_shed;
uniform float u_globe;     // projection transition: 0 flat mercator, 1 globe

out vec4 outState;

// Integer hash (lowbias32). NOT the classic fract(sin(dot)) hash: that one
// derives every draw from a single scalar, so a respawn's x and y were two
// offsets of the same 1-parameter curve — particles were literally born in
// collinear chains that then advected together as beaded streams.
uint hashU(uint x) {
	x ^= x >> 16u;
	x *= 0x7feb352du;
	x ^= x >> 15u;
	x *= 0x846ca68bu;
	x ^= x >> 16u;
	return x;
}

// Inverse of mercToLat; input stays within the mercator latitude clamp.
float latToMerc(float latDeg) {
	return 0.5 - log(tan(PI * 0.25 + radians(latDeg) * 0.5)) / (2.0 * PI);
}

void main() {
	vec4 s = texelFetch(u_state, ivec2(gl_FragCoord.xy), 0);
	vec2 pos = s.xy;
	float age = s.z + u_dt;

	float lat = mercToLat(pos.y);
	float lon = pos.x * 360.0 - 180.0;
	float u = blendedValue(lat, lon${uArgs});
	float v = blendedValue(lat, lon${vArgs});${temporalChunk}

	bool missing = isMissing(u) || isMissing(v);
	if (!missing) {
		// +u is east (+x); +v is north, which decreases mercator y. The globe
		// shows a mercator step cos(lat) smaller: compensate so high-latitude
		// particles keep their screen speed instead of freezing near the poles.
		float boost = mix(1.0, 1.0 / max(cos(radians(lat)), 0.05), u_globe);
		pos += vec2(u, -v) * (u_speedMerc * boost);
	}

	// Inside test, wrap-aware in x: the offset from the window's west edge,
	// wrapped into one world, must not exceed the window span.
	float spanX = u_bounds.z - u_bounds.x;
	float offX = fract(pos.x - u_bounds.x);
	bool outside = offX > spanX || pos.y < u_bounds.y || pos.y > u_bounds.w;

	// Independent draws from a per-particle, per-frame RNG stream.
	uint rng = hashU((uint(gl_FragCoord.y) * 8192u + uint(gl_FragCoord.x)) ^ hashU(u_frame));
	rng = hashU(rng);
	float life = u_maxAge * (0.3 + 1.4 * float(rng) * (1.0 / 4294967296.0));
	rng = hashU(rng);
	bool shed = float(rng) * (1.0 / 4294967296.0) < u_shed;
	if (missing || outside || shed || age > life) {
		rng = hashU(rng);
		float rx = float(rng) * (1.0 / 4294967296.0);
		rng = hashU(rng);
		float ry = float(rng) * (1.0 / 4294967296.0);
		float y = mix(u_bounds.y, u_bounds.w, ry);
		if (u_globe > 0.0) {
			// Equal-area vertical draw (uniform in sin lat): a mercator-uniform
			// draw over-samples high latitudes and piles spawns onto the poles
			// when the globe shows true angular distances.
			float sinNorth = sin(radians(mercToLat(u_bounds.y)));
			float sinSouth = sin(radians(mercToLat(u_bounds.w)));
			float yArea = latToMerc(degrees(asin(mix(sinSouth, sinNorth, ry))));
			y = mix(y, yArea, u_globe);
		}
		pos = vec2(u_bounds.x + spanX * rx, y);
		// Age 0 marks a fresh spawn; the draw pass hides it for one frame so a
		// particle respawning on missing data never flashes anywhere.
		age = 0.0;
	}

	outState = vec4(fract(pos.x), clamp(pos.y, 0.0, 1.0), age, s.w);
}
`;
};

const POINT_VERTEX_BODY = `
uniform sampler2D u_state;
uniform int u_stateW;
uniform float u_worldOffset;
uniform float u_sizePx;

out float v_alive;

void main() {
	vec4 s = texelFetch(u_state, ivec2(gl_VertexID % u_stateW, gl_VertexID / u_stateW), 0);
	v_alive = s.z > 0.0 ? 1.0 : 0.0;
	gl_Position = projectTile(vec2(s.x + u_worldOffset, s.y));
	gl_PointSize = u_sizePx;
}
`;

const pointVertexSource = (shaderData?: ProjectionShaderData): string => {
	if (shaderData) {
		return `#version 300 es
${shaderData.vertexShaderPrelude}
${shaderData.define}
${POINT_VERTEX_BODY}`;
	}
	return `#version 300 es
precision highp float;

uniform mat4 u_matrix;

vec4 projectTile(vec2 pos) {
	return u_matrix * vec4(pos, 0.0, 1.0);
}
${POINT_VERTEX_BODY}`;
};

const POINT_FRAGMENT = `#version 300 es
precision mediump float;
in float v_alive;
uniform vec3 u_color;
out vec4 outColor;
void main() {
	vec2 d = gl_PointCoord * 2.0 - 1.0;
	float a = v_alive * (1.0 - smoothstep(0.5, 1.0, length(d)));
	outColor = vec4(u_color * a, a);
}
`;

// ─── Trail reprojection (mercator homography) ────────────────────────────────

/**
 * The mercator-plane -> clip homography of a view matrix: columns/rows 0, 1
 * and 3 of the column-major 4x4 (the plane sits at z = 0). Valid for any flat
 * mercator camera, including rotation and pitch; not for the globe.
 */
const planeHomography = (m: ArrayLike<number>): Float64Array => {
	const idx = [0, 1, 3];
	const h = new Float64Array(9);
	for (let c = 0; c < 3; c++) {
		for (let r = 0; r < 3; r++) {
			h[c * 3 + r] = m[idx[c] * 4 + idx[r]];
		}
	}
	return h;
};

/** Column-major 3x3 inverse, or undefined for a singular matrix. */
const invert3 = (m: Float64Array): Float64Array | undefined => {
	const [a, b, c, d, e, f, g, h, i] = m;
	const A = e * i - f * h;
	const B = f * g - d * i;
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	if (!isFinite(det) || Math.abs(det) < 1e-24) return undefined;
	const s = 1 / det;
	// prettier-ignore
	return new Float64Array([
		A * s, (c * h - b * i) * s, (b * f - c * e) * s,
		B * s, (a * i - c * g) * s, (c * d - a * f) * s,
		C * s, (b * g - a * h) * s, (a * e - b * d) * s
	]);
};

/** Column-major 3x3 product a * b. */
const multiply3 = (a: Float64Array, b: Float64Array): Float64Array => {
	const out = new Float64Array(9);
	for (let c = 0; c < 3; c++) {
		for (let r = 0; r < 3; r++) {
			out[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2];
		}
	}
	return out;
};

// prettier-ignore
const IDENTITY3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

const sameMat = (a: Float64Array, b: Float64Array): boolean => {
	for (let i = 0; i < 9; i++) if (a[i] !== b[i]) return false;
	return true;
};

// ─── Particle system ─────────────────────────────────────────────────────────

interface ProgramInfo {
	program: WebGLProgram;
	uniforms: Map<string, WebGLUniformLocation>;
}

interface PingPong {
	textures: [WebGLTexture, WebGLTexture];
	fbos: [WebGLFramebuffer, WebGLFramebuffer];
	/** Index holding the most recently written image. */
	head: number;
}

const buildProgram = (
	gl: WebGL2RenderingContext,
	vertexSrc: string,
	fragmentSrc: string
): ProgramInfo => {
	const compile = (type: number, source: string): WebGLShader => {
		const shader = gl.createShader(type);
		if (!shader) throw new Error('gpu: could not create shader');
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			const log = gl.getShaderInfoLog(shader);
			gl.deleteShader(shader);
			throw new Error(`gpu: particle shader compile failed: ${log}\n${source}`);
		}
		return shader;
	};

	const program = gl.createProgram();
	if (!program) throw new Error('gpu: could not create particle program');
	gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSrc));
	gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSrc));
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		const log = gl.getProgramInfoLog(program);
		gl.deleteProgram(program);
		throw new Error(`gpu: particle program link failed: ${log}`);
	}

	const uniforms = new Map<string, WebGLUniformLocation>();
	const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
	for (let i = 0; i < count; i++) {
		const active = gl.getActiveUniform(program, i);
		if (!active) continue;
		const location = gl.getUniformLocation(program, active.name);
		if (location) uniforms.set(active.name.replace(/\[0\]$/, ''), location);
	}
	return { program, uniforms };
};

export class ParticleSystem {
	private gl: WebGL2RenderingContext;
	/** RGBA32F render targets need EXT_color_buffer_float; else stay a no-op. */
	readonly supported: boolean;

	private state: PingPong | undefined;
	private stateW = 0;
	private trail: PingPong | undefined;
	private trailW = 0;
	private trailH = 0;
	private trailDirty = true;

	private updatePrograms = new Map<string, ProgramInfo>();
	private static readonly UPDATE_PROGRAM_CACHE_MAX = 4;
	private pointPrograms = new Map<string, ProgramInfo>();
	private fadeProgram: ProgramInfo | undefined;
	private compositeProgram: ProgramInfo | undefined;
	private emptyVao: WebGLVertexArrayObject | null = null;

	/** Two-pass globe reprojection: programs per projection variant + mesh. */
	private unwarpPrograms = new Map<string, ProgramInfo>();
	private rewarpPrograms = new Map<string, ProgramInfo>();
	private warp: { texture: WebGLTexture; fbo: WebGLFramebuffer } | undefined;
	private warpMesh: {
		vao: WebGLVertexArrayObject;
		vertices: WebGLBuffer;
		indices: WebGLBuffer;
		indexCount: number;
	} | null = null;
	/** Previous frame's projection uniforms, for the globe trail warp. */
	private prevProjection: { variant: string; data: ProjectionSnapshot } | undefined;

	/** Update-step counter seeding the per-frame RNG stream. */
	private frame = 0;
	/** Mercator area of the last respawn window, for the zoom-out shed. */
	private prevBoundsArea = 0;
	/** Previous frame's mercator-plane homography, for trail reprojection. */
	private prevHomography: Float64Array | undefined;

	constructor(gl: WebGL2RenderingContext) {
		this.gl = gl;
		this.supported = gl.getExtension('EXT_color_buffer_float') !== null;
	}

	/**
	 * Advance the particles by one step and draw the trail image onto the
	 * currently bound target. Assumes MapLibre's custom-layer GL state
	 * (premultiplied blending) on entry and restores what it changes.
	 */
	render(opts: ParticleRenderOptions): void {
		if (!this.supported || opts.layers.length === 0) return;
		const gl = this.gl;

		// Snapshot the pieces of state the offscreen passes touch.
		const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
		const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
		const blendOn = gl.isEnabled(gl.BLEND);
		const depthOn = gl.isEnabled(gl.DEPTH_TEST);
		const stencilOn = gl.isEnabled(gl.STENCIL_TEST);
		const scissorOn = gl.isEnabled(gl.SCISSOR_TEST);
		const blendSrcRgb = gl.getParameter(gl.BLEND_SRC_RGB) as number;
		const blendDstRgb = gl.getParameter(gl.BLEND_DST_RGB) as number;
		const blendSrcAlpha = gl.getParameter(gl.BLEND_SRC_ALPHA) as number;
		const blendDstAlpha = gl.getParameter(gl.BLEND_DST_ALPHA) as number;
		gl.disable(gl.BLEND);
		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.STENCIL_TEST);
		gl.disable(gl.SCISSOR_TEST);

		this.emptyVao ??= gl.createVertexArray();
		gl.bindVertexArray(this.emptyVao);

		this.ensureState(opts);
		this.ensureTrail();
		this.updateParticles(opts);
		this.drawTrail(opts);

		// Back to the map's framebuffer and state for the composite.
		gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
		gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
		if (blendOn) gl.enable(gl.BLEND);
		if (depthOn) gl.enable(gl.DEPTH_TEST);
		if (stencilOn) gl.enable(gl.STENCIL_TEST);
		if (scissorOn) gl.enable(gl.SCISSOR_TEST);
		gl.blendFuncSeparate(blendSrcRgb, blendDstRgb, blendSrcAlpha, blendDstAlpha);

		this.composite(opts.opacity);
		gl.bindVertexArray(null);
	}

	/** Drop the trail history (e.g. the data changed identity). */
	clearTrails(): void {
		this.trailDirty = true;
	}

	dispose(): void {
		const gl = this.gl;
		this.deletePingPong(this.state);
		this.state = undefined;
		this.deletePingPong(this.trail);
		this.trail = undefined;
		for (const { program } of this.updatePrograms.values()) gl.deleteProgram(program);
		this.updatePrograms.clear();
		for (const { program } of this.pointPrograms.values()) gl.deleteProgram(program);
		this.pointPrograms.clear();
		for (const { program } of this.unwarpPrograms.values()) gl.deleteProgram(program);
		this.unwarpPrograms.clear();
		for (const { program } of this.rewarpPrograms.values()) gl.deleteProgram(program);
		this.rewarpPrograms.clear();
		if (this.warp) {
			gl.deleteTexture(this.warp.texture);
			gl.deleteFramebuffer(this.warp.fbo);
			this.warp = undefined;
		}
		if (this.warpMesh) {
			gl.deleteVertexArray(this.warpMesh.vao);
			gl.deleteBuffer(this.warpMesh.vertices);
			gl.deleteBuffer(this.warpMesh.indices);
			this.warpMesh = null;
		}
		this.prevProjection = undefined;
		if (this.fadeProgram) gl.deleteProgram(this.fadeProgram.program);
		this.fadeProgram = undefined;
		if (this.compositeProgram) gl.deleteProgram(this.compositeProgram.program);
		this.compositeProgram = undefined;
		if (this.emptyVao) {
			gl.deleteVertexArray(this.emptyVao);
			this.emptyVao = null;
		}
	}

	private deletePingPong(pair: PingPong | undefined): void {
		if (!pair) return;
		const gl = this.gl;
		for (const texture of pair.textures) gl.deleteTexture(texture);
		for (const fbo of pair.fbos) gl.deleteFramebuffer(fbo);
	}

	private createTarget(
		w: number,
		h: number,
		internalFormat: number,
		format: number,
		type: number,
		data: ArrayBufferView | null,
		/** LINEAR for the trail images (reprojection resamples them). */
		filter: number
	): { texture: WebGLTexture; fbo: WebGLFramebuffer } {
		const gl = this.gl;
		const texture = gl.createTexture();
		const fbo = gl.createFramebuffer();
		if (!texture || !fbo) throw new Error('gpu: could not create particle target');
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, data);
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
		return { texture, fbo };
	}

	/** (Re)build the state pair when missing or the configured count changed. */
	private ensureState(opts: ParticleRenderOptions): void {
		const w = Math.max(2, Math.ceil(Math.sqrt(opts.config.count)));
		if (this.state && this.stateW === w) return;
		this.deletePingPong(this.state);
		this.stateW = w;

		// Seed uniformly across the respawn window with staggered ages, so the
		// animation starts dense instead of trickling in over one lifetime. On
		// the globe the vertical draw is equal-area, like the shader's respawn.
		const [x0, y0, x1, y1] = opts.bounds;
		const maxAge = opts.config.maxAgeSec ?? 5;
		const mercLat = (y: number): number =>
			(Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
		const latMerc = (lat: number): number =>
			0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);
		const sinNorth = Math.sin((mercLat(y0) * Math.PI) / 180);
		const sinSouth = Math.sin((mercLat(y1) * Math.PI) / 180);
		const seed = new Float32Array(w * w * 4);
		for (let i = 0; i < w * w; i++) {
			const x = x0 + (x1 - x0) * Math.random();
			const ry = Math.random();
			const yFlat = y0 + (y1 - y0) * ry;
			const yArea = latMerc((Math.asin(sinSouth + (sinNorth - sinSouth) * ry) * 180) / Math.PI);
			seed[i * 4] = x - Math.floor(x);
			seed[i * 4 + 1] = Math.min(1, Math.max(0, yFlat + (yArea - yFlat) * opts.globe));
			seed[i * 4 + 2] = maxAge * Math.random();
		}

		const gl = this.gl;
		const a = this.createTarget(w, w, gl.RGBA32F, gl.RGBA, gl.FLOAT, seed, gl.NEAREST);
		const b = this.createTarget(w, w, gl.RGBA32F, gl.RGBA, gl.FLOAT, seed, gl.NEAREST);
		this.state = { textures: [a.texture, b.texture], fbos: [a.fbo, b.fbo], head: 0 };
	}

	/** (Re)build the trail pair to the drawing buffer size. */
	private ensureTrail(): void {
		const gl = this.gl;
		const w = gl.drawingBufferWidth;
		const h = gl.drawingBufferHeight;
		if (this.trail && this.trailW === w && this.trailH === h) return;
		this.deletePingPong(this.trail);
		this.trailW = w;
		this.trailH = h;
		const a = this.createTarget(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.LINEAR);
		const b = this.createTarget(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.LINEAR);
		this.trail = { textures: [a.texture, b.texture], fbos: [a.fbo, b.fbo], head: 0 };
		if (this.warp) {
			gl.deleteTexture(this.warp.texture);
			gl.deleteFramebuffer(this.warp.fbo);
		}
		this.warp = this.createTarget(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.LINEAR);
		this.trailDirty = true;
	}

	/** Lazily built subdivided unit-square mesh for the globe warp passes. */
	private getWarpMesh(): NonNullable<ParticleSystem['warpMesh']> {
		if (this.warpMesh) return this.warpMesh;
		const gl = this.gl;
		const n = WARP_MESH_N;
		const vertices = new Float32Array((n + 1) * (n + 1) * 2);
		let k = 0;
		for (let j = 0; j <= n; j++) {
			for (let i = 0; i <= n; i++) {
				vertices[k++] = i / n;
				vertices[k++] = j / n;
			}
		}
		const indices = new Uint16Array(n * n * 6);
		k = 0;
		for (let j = 0; j < n; j++) {
			for (let i = 0; i < n; i++) {
				const a = j * (n + 1) + i;
				const b = a + 1;
				const c = a + n + 1;
				const d = c + 1;
				indices[k++] = a;
				indices[k++] = c;
				indices[k++] = b;
				indices[k++] = b;
				indices[k++] = c;
				indices[k++] = d;
			}
		}
		const vertexBuffer = gl.createBuffer();
		const indexBuffer = gl.createBuffer();
		const vao = gl.createVertexArray();
		if (!vertexBuffer || !indexBuffer || !vao) {
			throw new Error('gpu: could not create warp mesh');
		}
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
		// Both warp shaders pin a_uv to location 0, so one VAO serves them all.
		gl.enableVertexAttribArray(0);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);
		this.warpMesh = { vao, vertices: vertexBuffer, indices: indexBuffer, indexCount: k };
		return this.warpMesh;
	}

	private getWarpProgram(
		cache: Map<string, ProgramInfo>,
		shaderData: ProjectionShaderData,
		body: string,
		fragment: string
	): ProgramInfo {
		let info = cache.get(shaderData.variantName);
		if (!info) {
			const vertex = `#version 300 es
${shaderData.vertexShaderPrelude}
${shaderData.define}
${body}`;
			info = buildProgram(this.gl, vertex, fragment);
			cache.set(shaderData.variantName, info);
		}
		return info;
	}

	/** Upload the projection prelude's uniforms from a snapshot or live data. */
	private uploadProjectionUniforms(
		u: (name: string) => WebGLUniformLocation | null,
		data: ProjectionSnapshot | GpuProjectionData
	): void {
		const gl = this.gl;
		gl.uniformMatrix4fv(u('u_projection_matrix'), false, data.mainMatrix as Float32List);
		gl.uniformMatrix4fv(
			u('u_projection_fallback_matrix'),
			false,
			data.fallbackMatrix as Float32List
		);
		gl.uniform4f(u('u_projection_tile_mercator_coords'), ...data.tileMercatorCoords);
		gl.uniform4f(u('u_projection_clipping_plane'), ...data.clippingPlane);
		gl.uniform1f(u('u_projection_transition'), data.projectionTransition);
	}

	/**
	 * Reproject the previous trail image through mercator space: unwarp it with
	 * the previous frame's projectTile, then rewarp (and decay) with the
	 * current one — the globe counterpart of the flat homography fade. Leaves
	 * the target framebuffer/viewport bound like the plain fade pass does.
	 */
	private warpTrail(
		opts: ParticleRenderOptions,
		prevData: ProjectionSnapshot,
		fadeOpacity: number
	): void {
		const gl = this.gl;
		const trail = this.trail!;
		const shaderData = opts.projection!.shaderData;
		const mesh = this.getWarpMesh();
		gl.bindVertexArray(mesh.vao);

		// Pass 1: previous screen-space trails into the mercator window.
		const unwarp = this.getWarpProgram(
			this.unwarpPrograms,
			shaderData,
			UNWARP_VERTEX_BODY,
			UNWARP_FRAGMENT
		);
		let u = (name: string): WebGLUniformLocation | null => unwarp.uniforms.get(name) ?? null;
		gl.useProgram(unwarp.program);
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.warp!.fbo);
		gl.viewport(0, 0, this.trailW, this.trailH);
		this.uploadProjectionUniforms(u, prevData);
		gl.uniform4f(u('u_window'), ...opts.bounds);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, trail.textures[trail.head]);
		gl.uniform1i(u('u_trail'), 0);
		gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0);

		// Pass 2: forward through the current projection, with the decay. The
		// mesh does not cover pixels outside the window, so clear first.
		const rewarp = this.getWarpProgram(
			this.rewarpPrograms,
			shaderData,
			REWARP_VERTEX_BODY,
			REWARP_FRAGMENT
		);
		u = (name: string): WebGLUniformLocation | null => rewarp.uniforms.get(name) ?? null;
		gl.useProgram(rewarp.program);
		gl.bindFramebuffer(gl.FRAMEBUFFER, trail.fbos[1 - trail.head]);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		this.uploadProjectionUniforms(u, opts.projection!.data);
		gl.uniform4f(u('u_window'), ...opts.bounds);
		gl.uniform1f(u('u_fade'), fadeOpacity);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.warp!.texture);
		gl.uniform1i(u('u_warp'), 0);
		gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0);

		gl.bindVertexArray(this.emptyVao);
	}

	private getUpdateProgram(opts: ParticleRenderOptions): ProgramInfo {
		const spec: SamplingShaderSpec = {
			layers: opts.layers.map((layer, i) => layerSpecOf(layer, i === opts.layers.length - 1)),
			// Linear component interpolation is the standard for advection; the
			// higher-order raster methods buy nothing at particle step sizes.
			interpolation: 'linear'
		};
		const temporal = opts.prev !== undefined && opts.layers.length === 1;
		const key = shaderKey({ ...spec, temporal });
		const cached = this.updatePrograms.get(key);
		if (cached) {
			this.updatePrograms.delete(key);
			this.updatePrograms.set(key, cached);
			return cached;
		}
		const info = buildProgram(this.gl, FULLSCREEN_VERTEX, updateFragmentSource(spec, temporal));
		this.updatePrograms.set(key, info);
		if (this.updatePrograms.size > ParticleSystem.UPDATE_PROGRAM_CACHE_MAX) {
			const oldest = this.updatePrograms.keys().next().value!;
			this.gl.deleteProgram(this.updatePrograms.get(oldest)!.program);
			this.updatePrograms.delete(oldest);
		}
		return info;
	}

	private getPointProgram(shaderData?: ProjectionShaderData): ProgramInfo {
		const key = shaderData?.variantName ?? 'plain';
		let info = this.pointPrograms.get(key);
		if (!info) {
			info = buildProgram(this.gl, pointVertexSource(shaderData), POINT_FRAGMENT);
			this.pointPrograms.set(key, info);
		}
		return info;
	}

	private updateParticles(opts: ParticleRenderOptions): void {
		const gl = this.gl;
		const state = this.state!;
		const info = this.getUpdateProgram(opts);
		const u = (name: string): WebGLUniformLocation | null => info.uniforms.get(name) ?? null;
		const temporal = opts.prev !== undefined && opts.layers.length === 1;

		gl.useProgram(info.program);
		gl.bindFramebuffer(gl.FRAMEBUFFER, state.fbos[1 - state.head]);
		gl.viewport(0, 0, this.stateW, this.stateW);

		let unit = 0;
		const bindTexture = (name: string, texture: WebGLTexture): void => {
			gl.activeTexture(gl.TEXTURE0 + unit);
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.uniform1i(u(name), unit);
			unit++;
		};

		bindTexture('u_state', state.textures[state.head]);
		for (let i = 0; i < opts.layers.length; i++) {
			const layer = opts.layers[i];
			bindTexture(`u_u${i}`, layer.uTexture);
			bindTexture(`u_v${i}`, layer.vTexture);
			const spec = layerSpecOf(layer, i === opts.layers.length - 1);
			uploadGridLayerUniforms(gl, u, i, spec, layer, bindTexture);
		}
		if (temporal && opts.prev) {
			bindTexture('u_uPrev0', opts.prev.uTexture);
			bindTexture('u_vPrev0', opts.prev.vTexture);
			gl.uniform1f(u('u_mix'), opts.mix);
		}

		gl.uniform1f(u('u_dt'), opts.dtSeconds);
		this.frame = (this.frame + 1) >>> 0;
		gl.uniform1ui(u('u_frame'), this.frame);
		gl.uniform1f(u('u_speedMerc'), opts.mercPerMps);
		gl.uniform1f(u('u_maxAge'), opts.config.maxAgeSec ?? 5);
		gl.uniform4f(u('u_bounds'), ...opts.bounds);
		gl.uniform1f(u('u_globe'), opts.globe);

		// Zoom-out shed: a grown window keeps every old particle inside it, so
		// without this the old viewport's population lingers as a dense block
		// until natural deaths thin it (~a lifetime). Killing the area surplus
		// keeps density per screen; an animated zoom sheds a little per frame,
		// an instant jump redistributes in one.
		const area = (opts.bounds[2] - opts.bounds[0]) * (opts.bounds[3] - opts.bounds[1]);
		const shed =
			this.prevBoundsArea > 0 && area > this.prevBoundsArea ? 1 - this.prevBoundsArea / area : 0;
		this.prevBoundsArea = area;
		gl.uniform1f(u('u_shed'), shed);

		gl.drawArrays(gl.TRIANGLES, 0, 3);
		state.head = 1 - state.head;
	}

	private drawTrail(opts: ParticleRenderOptions): void {
		const gl = this.gl;
		const trail = this.trail!;
		const state = this.state!;

		// The trail image lives in screen space. On a flat mercator camera the
		// plane -> screen mapping is a homography, so a camera move (pan, zoom,
		// rotate, pitch) *reprojects* the previous frame's trails to their new
		// screen positions during the fade pass — the history follows the map.
		// On the globe the mapping is not planar; there the history is warped
		// through mercator space with the real projectTile of both frames
		// (warpTrail), so trails survive rotation, zoom and the transition too.
		const p = opts.projection?.data;
		const onGlobe = (p?.projectionTransition ?? 0) > 0;
		const matrix = p?.mainMatrix ?? opts.matrix ?? IDENTITY3;
		let reproject: Float32Array = IDENTITY3;
		let warpFrom: ProjectionSnapshot | undefined;
		if (onGlobe && opts.projection) {
			this.prevHomography = undefined;
			const variant = opts.projection.shaderData.variantName;
			const cur = snapshotProjection(p!);
			const prev = this.prevProjection;
			if (!prev || prev.variant !== variant) {
				// First globe frame (or a variant switch): no usable history map.
				this.trailDirty = true;
			} else if (!sameProjection(prev.data, cur)) {
				warpFrom = prev.data;
			}
			this.prevProjection = { variant, data: cur };
		} else {
			this.prevProjection = undefined;
			const homography = planeHomography(matrix);
			const prev = this.prevHomography;
			if (prev && !sameMat(prev, homography)) {
				const inverse = invert3(homography);
				if (inverse) {
					reproject = Float32Array.from(multiply3(prev, inverse));
				} else {
					this.trailDirty = true;
				}
			} else if (!prev) {
				// Coming from the globe (or the first frame): no usable history map.
				this.trailDirty = true;
			}
			this.prevHomography = homography;
		}
		if (this.trailDirty) {
			this.trailDirty = false;
			gl.clearColor(0, 0, 0, 0);
			for (const fbo of trail.fbos) {
				gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
				gl.clear(gl.COLOR_BUFFER_BIT);
			}
		}

		gl.viewport(0, 0, this.trailW, this.trailH);

		// 1. Decayed copy of the previous trail image, reprojected to the new
		// camera. Normalise the per-frame persistence to the actual frame time.
		const fadeOpacity = Math.pow(
			Math.min(1, Math.max(0, opts.config.fadeOpacity ?? 0.96)),
			opts.dtSeconds * 60
		);
		if (warpFrom) {
			// Globe camera move: two-pass warp through mercator space.
			this.warpTrail(opts, warpFrom, fadeOpacity);
		} else {
			gl.bindFramebuffer(gl.FRAMEBUFFER, trail.fbos[1 - trail.head]);
			this.fadeProgram ??= buildProgram(gl, FULLSCREEN_VERTEX, FADE_FRAGMENT);
			const fade = this.fadeProgram;
			gl.useProgram(fade.program);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, trail.textures[trail.head]);
			gl.uniform1i(fade.uniforms.get('u_trail') ?? null, 0);
			gl.uniform1f(fade.uniforms.get('u_fade') ?? null, fadeOpacity);
			gl.uniformMatrix3fv(fade.uniforms.get('u_reproject') ?? null, false, reproject);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		}

		// 2. The particles on top, premultiplied over the faded history.
		const point = this.getPointProgram(opts.projection?.shaderData);
		const u = (name: string): WebGLUniformLocation | null => point.uniforms.get(name) ?? null;
		gl.useProgram(point.program);
		if (opts.projection) {
			const data = opts.projection.data;
			gl.uniformMatrix4fv(u('u_projection_matrix'), false, data.mainMatrix as Float32List);
			gl.uniformMatrix4fv(
				u('u_projection_fallback_matrix'),
				false,
				data.fallbackMatrix as Float32List
			);
			gl.uniform4f(u('u_projection_tile_mercator_coords'), ...data.tileMercatorCoords);
			gl.uniform4f(u('u_projection_clipping_plane'), ...data.clippingPlane);
			gl.uniform1f(u('u_projection_transition'), data.projectionTransition);
		} else {
			gl.uniformMatrix4fv(u('u_matrix'), false, opts.matrix as Float32List);
		}
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, state.textures[state.head]);
		gl.uniform1i(u('u_state'), 0);
		gl.uniform1i(u('u_stateW'), this.stateW);
		gl.uniform1f(u('u_sizePx'), opts.sizeDevicePx);
		gl.uniform3f(u('u_color'), ...opts.config.color);

		gl.enable(gl.BLEND);
		gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		for (const offset of opts.worldOffsets) {
			gl.uniform1f(u('u_worldOffset'), offset);
			gl.drawArrays(gl.POINTS, 0, this.stateW * this.stateW);
		}
		gl.disable(gl.BLEND);

		trail.head = 1 - trail.head;
	}

	/** Draw the trail image over the map (relies on MapLibre's blend state). */
	private composite(opacity: number): void {
		const gl = this.gl;
		const trail = this.trail!;
		this.compositeProgram ??= buildProgram(gl, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
		const info = this.compositeProgram;
		gl.useProgram(info.program);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, trail.textures[trail.head]);
		gl.uniform1i(info.uniforms.get('u_trail') ?? null, 0);
		gl.uniform1f(info.uniforms.get('u_opacity') ?? null, opacity);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}
}
