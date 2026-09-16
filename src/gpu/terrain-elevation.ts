/**
 * Terrain elevation for the custom layer: one mercator-space elevation
 * texture (metres, exaggeration applied) composited from MapLibre's own
 * raster-dem tiles, so every vertex shader of the layer (raster mesh,
 * isoline pass, arrows, particles) can look up the ground height at any
 * base-world mercator coordinate and project it with `projectTileFor3D`.
 *
 * MapLibre drapes only its built-in layer types over the terrain mesh;
 * custom layers draw straight into the main framebuffer, so without this the
 * weather field is a flat sheet at sea level. The map exposes the pieces
 * needed to follow the surface instead: the renderable terrain tiles of the
 * current view and, per tile, the decoded DEM texture with its unpack vector
 * and the tile-to-DEM matrix (`Terrain.getTerrainData`) — the same inputs the
 * map's shaders feed into `get_elevation`, which is copied here verbatim.
 */

/** Uniform payload of the elevation map for the vertex shaders. */
export interface GpuElevationMap {
	texture: WebGLTexture;
	/**
	 * (x0, y0, 1/w, 1/h) of the map's rectangle in mercator space; x spans
	 * the view's world copies (may extend beyond [0, 1]), y is [0..1].
	 */
	rect: [number, number, number, number];
	/** The rectangle as (x0, y0, x1, y1): the area with usable elevation. */
	bounds: [number, number, number, number];
	/**
	 * Quad subdivision the raster mesh needs across `bounds` to follow the
	 * relief at the view's DEM resolution.
	 */
	meshN: number;
	/**
	 * Metres to the projection's elevation unit. MapLibre's custom-layer
	 * mercator matrix takes z as a conformal world fraction (1 = the world's
	 * width at the view centre's latitude), the globe prelude takes metres;
	 * the layer sets this per frame from the map's projection state.
	 */
	scale: number;
}

/** The subset of MapLibre's `Terrain` this reads (structurally typed). */
export interface TerrainSource {
	tileManager: {
		getRenderableTiles(): {
			tileID: { wrap: number; canonical: { z: number; x: number; y: number } };
		}[];
	};
	getTerrainData(tileID: { canonical: { z: number; x: number; y: number } }): {
		u_terrain_dim: number;
		u_terrain_matrix: ArrayLike<number>;
		u_terrain_unpack: ArrayLike<number>;
		u_terrain_exaggeration: number;
		texture: WebGLTexture;
		tile?: { tileID: { key: string } } | null;
	};
}

/** Largest edge of the elevation texture; the DEM is downsampled past it. */
const MAX_SIZE = 2048;
/** Mesh cells per DEM tile of the finest renderable zoom (512px on screen). */
const MESH_CELLS_PER_TILE = 64;
const MESH_N_MIN = 128;
const MESH_N_MAX = 512;

const EXTENT = 8192;

const VERTEX = `#version 300 es
precision highp float;
in vec2 a_uv;
// Tile rectangle in the elevation map's clip space: (x0, y0, x1, y1).
uniform vec4 u_tileClip;
out vec2 v_local;
void main() {
	v_local = a_uv * ${EXTENT}.0;
	gl_Position = vec4(mix(u_tileClip.xy, u_tileClip.zw, a_uv), 0.0, 1.0);
}
`;

// The DEM texture carries a one-texel border (hence the +1) and packs metres
// into RGB via the unpack vector; MapLibre's get_elevation, bilinear.
const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_local;
uniform sampler2D u_terrain;
uniform float u_terrain_dim;
uniform mat4 u_terrain_matrix;
uniform vec4 u_terrain_unpack;
uniform float u_terrain_exaggeration;
out float outElevation;

float ele(ivec2 pos) {
	vec4 rgb = (texelFetch(u_terrain, pos, 0) * 255.0) * u_terrain_unpack;
	return rgb.r + rgb.g + rgb.b - u_terrain_unpack.a;
}

void main() {
	vec2 coord = (u_terrain_matrix * vec4(v_local, 0.0, 1.0)).xy * u_terrain_dim + 1.0;
	vec2 f = fract(coord);
	ivec2 c = ivec2(floor(coord));
	ivec2 hi = textureSize(u_terrain, 0) - 1;
	float tl = ele(clamp(c, ivec2(0), hi));
	float tr = ele(clamp(c + ivec2(1, 0), ivec2(0), hi));
	float bl = ele(clamp(c + ivec2(0, 1), ivec2(0), hi));
	float br = ele(clamp(c + ivec2(1, 1), ivec2(0), hi));
	outElevation = mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y) * u_terrain_exaggeration;
}
`;

export class TerrainElevationBuilder {
	private gl: WebGL2RenderingContext;
	/** R32F render targets need EXT_color_buffer_float; without it, no terrain. */
	readonly supported: boolean;

	private program: WebGLProgram | undefined;
	private uniforms = new Map<string, WebGLUniformLocation>();
	private vao: WebGLVertexArrayObject | null = null;
	private quadBuffer: WebGLBuffer | null = null;
	private texture: WebGLTexture | null = null;
	private fbo: WebGLFramebuffer | null = null;
	private width = 0;
	private height = 0;
	private current: GpuElevationMap | undefined;
	/** Identity of the composite: renderable tiles + the DEM each resolved to. */
	private key = '';

	constructor(gl: WebGL2RenderingContext) {
		this.gl = gl;
		this.supported = gl.getExtension('EXT_color_buffer_float') !== null;
	}

	/**
	 * Composite the view's terrain tiles into the elevation map. Cheap when
	 * nothing changed (same tiles, same DEMs): the previous map is returned.
	 * Restores the framebuffer and viewport it found bound.
	 */
	update(terrain: TerrainSource): GpuElevationMap | undefined {
		if (!this.supported) return undefined;
		const gl = this.gl;
		const tiles = terrain.tileManager.getRenderableTiles();
		if (tiles.length === 0) return undefined;

		// The map is laid out in the view's own world copies (x beyond [0, 1]
		// across the antimeridian); the lookup folds base-world positions into
		// it, so a view straddling the seam keeps full resolution.
		const entries: {
			x0: number;
			y0: number;
			x1: number;
			y1: number;
			data: ReturnType<TerrainSource['getTerrainData']>;
		}[] = [];
		let zMax = 0;
		const keyParts: string[] = [];
		for (const tile of tiles) {
			const { z, x, y } = tile.tileID.canonical;
			const wrap = tile.tileID.wrap;
			const n = Math.pow(2, z);
			const data = terrain.getTerrainData(tile.tileID);
			entries.push({
				x0: x / n + wrap,
				y0: y / n,
				x1: (x + 1) / n + wrap,
				y1: (y + 1) / n,
				data
			});
			zMax = Math.max(zMax, z);
			keyParts.push(
				`${z}/${x}/${y}/${wrap}:${data.tile?.tileID.key ?? '-'}:${data.u_terrain_exaggeration}`
			);
		}
		const key = keyParts.join(',');
		if (this.current && key === this.key) return this.current;

		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		for (const e of entries) {
			x0 = Math.min(x0, e.x0);
			y0 = Math.min(y0, e.y0);
			x1 = Math.max(x1, e.x1);
			y1 = Math.max(y1, e.y1);
		}

		// Texel density of the finest tiles (512 per tile), capped by MAX_SIZE.
		const texelsPerUnit = 512 * Math.pow(2, zMax);
		let width = Math.ceil((x1 - x0) * texelsPerUnit);
		let height = Math.ceil((y1 - y0) * texelsPerUnit);
		const scale = Math.min(1, MAX_SIZE / Math.max(width, height));
		width = Math.max(1, Math.round(width * scale));
		height = Math.max(1, Math.round(height * scale));

		const tilesAcross = Math.max(x1 - x0, y1 - y0) * Math.pow(2, zMax);
		const meshN = Math.min(
			MESH_N_MAX,
			Math.max(MESH_N_MIN, Math.pow(2, Math.ceil(Math.log2(tilesAcross * MESH_CELLS_PER_TILE))))
		);

		const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
		const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
		const blendOn = gl.isEnabled(gl.BLEND);
		const depthOn = gl.isEnabled(gl.DEPTH_TEST);
		const stencilOn = gl.isEnabled(gl.STENCIL_TEST);
		const scissorOn = gl.isEnabled(gl.SCISSOR_TEST);
		gl.disable(gl.BLEND);
		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.STENCIL_TEST);
		gl.disable(gl.SCISSOR_TEST);

		this.ensureTarget(width, height);
		const info = this.getProgram();
		gl.useProgram(info);
		gl.bindVertexArray(this.vao);
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
		gl.viewport(0, 0, width, height);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);

		const u = (name: string): WebGLUniformLocation | null => this.uniforms.get(name) ?? null;
		gl.activeTexture(gl.TEXTURE0);
		gl.uniform1i(u('u_terrain'), 0);
		const sx = 2 / (x1 - x0);
		const sy = 2 / (y1 - y0);
		for (const e of entries) {
			const d = e.data;
			gl.bindTexture(gl.TEXTURE_2D, d.texture);
			gl.uniform1f(u('u_terrain_dim'), d.u_terrain_dim);
			gl.uniformMatrix4fv(u('u_terrain_matrix'), false, d.u_terrain_matrix as Float32List);
			gl.uniform4f(
				u('u_terrain_unpack'),
				d.u_terrain_unpack[0],
				d.u_terrain_unpack[1],
				d.u_terrain_unpack[2],
				d.u_terrain_unpack[3]
			);
			gl.uniform1f(u('u_terrain_exaggeration'), d.u_terrain_exaggeration);
			// Mercator y grows downwards while clip y grows upwards; the map's
			// texel row 0 is the top (y0) edge, matching the layer's lookup.
			gl.uniform4f(
				u('u_tileClip'),
				(e.x0 - x0) * sx - 1,
				(e.y0 - y0) * sy - 1,
				(e.x1 - x0) * sx - 1,
				(e.y1 - y0) * sy - 1
			);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		}

		gl.bindVertexArray(null);
		gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
		gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
		if (blendOn) gl.enable(gl.BLEND);
		if (depthOn) gl.enable(gl.DEPTH_TEST);
		if (stencilOn) gl.enable(gl.STENCIL_TEST);
		if (scissorOn) gl.enable(gl.SCISSOR_TEST);

		this.key = key;
		this.current = {
			texture: this.texture!,
			rect: [x0, y0, 1 / (x1 - x0), 1 / (y1 - y0)],
			bounds: [x0, y0, x1, y1],
			meshN,
			scale: 1
		};
		return this.current;
	}

	dispose(): void {
		const gl = this.gl;
		if (this.program) gl.deleteProgram(this.program);
		this.program = undefined;
		this.uniforms.clear();
		if (this.vao) gl.deleteVertexArray(this.vao);
		this.vao = null;
		if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
		this.quadBuffer = null;
		if (this.texture) gl.deleteTexture(this.texture);
		this.texture = null;
		if (this.fbo) gl.deleteFramebuffer(this.fbo);
		this.fbo = null;
		this.width = 0;
		this.height = 0;
		this.current = undefined;
		this.key = '';
	}

	private ensureTarget(width: number, height: number): void {
		const gl = this.gl;
		if (this.texture && this.fbo && this.width === width && this.height === height) return;
		if (this.texture) gl.deleteTexture(this.texture);
		if (this.fbo) gl.deleteFramebuffer(this.fbo);
		const texture = gl.createTexture();
		const fbo = gl.createFramebuffer();
		if (!texture || !fbo) throw new Error('gpu: could not create elevation target');
		gl.bindTexture(gl.TEXTURE_2D, texture);
		// Filtering float textures needs another extension; the shaders
		// interpolate by hand from texelFetch.
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, null);
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
		this.texture = texture;
		this.fbo = fbo;
		this.width = width;
		this.height = height;
		this.current = undefined;
	}

	private getProgram(): WebGLProgram {
		if (this.program) return this.program;
		const gl = this.gl;
		const compile = (type: number, source: string): WebGLShader => {
			const shader = gl.createShader(type);
			if (!shader) throw new Error('gpu: could not create shader');
			gl.shaderSource(shader, source);
			gl.compileShader(shader);
			if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
				const log = gl.getShaderInfoLog(shader);
				gl.deleteShader(shader);
				throw new Error(`gpu: elevation shader compile failed: ${log}`);
			}
			return shader;
		};
		const program = gl.createProgram();
		if (!program) throw new Error('gpu: could not create elevation program');
		gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
		gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			const log = gl.getProgramInfoLog(program);
			gl.deleteProgram(program);
			throw new Error(`gpu: elevation program link failed: ${log}`);
		}
		const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
		for (let i = 0; i < count; i++) {
			const active = gl.getActiveUniform(program, i);
			if (!active) continue;
			const location = gl.getUniformLocation(program, active.name);
			if (location) this.uniforms.set(active.name, location);
		}

		const quad = gl.createBuffer();
		const vao = gl.createVertexArray();
		if (!quad || !vao) throw new Error('gpu: could not create elevation quad');
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, quad);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
		const aUv = gl.getAttribLocation(program, 'a_uv');
		gl.enableVertexAttribArray(aUv);
		gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);
		this.quadBuffer = quad;
		this.vao = vao;
		this.program = program;
		return program;
	}
}

/**
 * GLSL for the vertex shaders: `elevationAt(baseWorldMercator)` in metres
 * (bilinear from the elevation map, 0 outside it) and `projectPoint`, the
 * projection call the shader bodies use. `elevated` false yields the flat
 * `projectTile` so the same bodies serve both variants. Declares the
 * world-offset uniform the bodies share (the elevated lookup folds it away).
 */
export const projectPointSource = (elevated: boolean): string => {
	if (!elevated) {
		return `
uniform float u_worldOffset;

vec4 projectPoint(vec2 pos) {
	return projectTile(pos);
}

vec4 projectSurfacePoint(vec2 pos) {
	return projectTile(pos);
}
`;
	}
	return `
precision highp sampler2D;
// The depth pre-pass and the colour passes rasterize the same mesh from
// different programs; their depths must match bit for bit (LEQUAL test).
invariant gl_Position;
uniform sampler2D u_elevation;
// (x0, y0, 1/w, 1/h) of the elevation map in mercator [0..1] space.
uniform vec4 u_elevationRect;
// Metres to the prelude's elevation unit (see GpuElevationMap.scale).
uniform float u_elevationScale;
uniform float u_worldOffset;

float elevationAt(vec2 merc) {
	vec2 p = (merc - u_elevationRect.xy) * u_elevationRect.zw;
	// The map may sit in a neighbouring world copy (antimeridian views).
	if (p.x < 0.0) p.x += u_elevationRect.z;
	else if (p.x > 1.0) p.x -= u_elevationRect.z;
	if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) return 0.0;
	vec2 size = vec2(textureSize(u_elevation, 0));
	vec2 c = p * size - 0.5;
	vec2 f = fract(c);
	ivec2 i0 = ivec2(floor(c));
	ivec2 hi = ivec2(size) - 1;
	float tl = texelFetch(u_elevation, clamp(i0, ivec2(0), hi), 0).r;
	float tr = texelFetch(u_elevation, clamp(i0 + ivec2(1, 0), ivec2(0), hi), 0).r;
	float bl = texelFetch(u_elevation, clamp(i0 + ivec2(0, 1), ivec2(0), hi), 0).r;
	float br = texelFetch(u_elevation, clamp(i0 + ivec2(1, 1), ivec2(0), hi), 0).r;
	return mix(mix(tl, tr, f.x), mix(bl, br, f.x), f.y);
}

// pos carries the world offset; the elevation map is base-world.
vec4 projectPoint(vec2 pos) {
	return projectTileFor3D(pos, elevationAt(vec2(pos.x - u_worldOffset, pos.y)) * u_elevationScale);
}

// The raster mesh of the current world copy: its rectangle (base world) and
// cells per side, so points can be placed exactly on the rasterized surface.
uniform vec4 u_surfaceQuad;
uniform float u_surfaceN;

// Height of the drawn surface mesh at a base-world position. The mesh is
// linear across each triangle (cells split along the (i+1,j)-(i,j+1)
// diagonal, see the renderer's mesh), so a point at this height lies on the
// rasterized surface and passes its depth test; the mesh vertices compute
// their height the same way, from the same lattice positions.
float surfaceElevationAt(vec2 merc) {
	vec2 size = u_surfaceQuad.zw - u_surfaceQuad.xy;
	vec2 g = clamp((merc - u_surfaceQuad.xy) / size * u_surfaceN, 0.0, u_surfaceN);
	vec2 cell = min(floor(g), u_surfaceN - 1.0);
	vec2 f = g - cell;
	float ea = elevationAt(mix(u_surfaceQuad.xy, u_surfaceQuad.zw, cell / u_surfaceN));
	float eb = elevationAt(mix(u_surfaceQuad.xy, u_surfaceQuad.zw, (cell + vec2(1.0, 0.0)) / u_surfaceN));
	float ec = elevationAt(mix(u_surfaceQuad.xy, u_surfaceQuad.zw, (cell + vec2(0.0, 1.0)) / u_surfaceN));
	float ed = elevationAt(mix(u_surfaceQuad.xy, u_surfaceQuad.zw, (cell + 1.0) / u_surfaceN));
	if (f.x + f.y < 1.0) return ea + f.x * (eb - ea) + f.y * (ec - ea);
	return ed + (1.0 - f.x) * (ec - ed) + (1.0 - f.y) * (eb - ed);
}

// Depth nudge towards the camera (NDC) covering the rounding between this
// evaluation and the mesh rasterization; well below any ridge's parallax.
const float SURFACE_DEPTH_BIAS = 5e-5;

// A point on the drawn surface (arrows, particles): depth-tested against the
// raster mesh, it must not fight with the very surface it sits on.
vec4 projectSurfacePoint(vec2 pos) {
	vec4 clip = projectTileFor3D(pos, surfaceElevationAt(vec2(pos.x - u_worldOffset, pos.y)) * u_elevationScale);
	clip.z -= SURFACE_DEPTH_BIAS * clip.w;
	return clip;
}
`;
};

/**
 * Visibility pass (see surface-target.ts): the surface mesh drawn flat over
 * the elevation map's rectangle, each fragment projecting its ground point
 * through the map's camera and comparing that depth with the surface depth
 * rendered on screen. 1 = the ground here is visible, 0 = hidden behind a
 * ridge; off-screen and behind-camera points count as visible (the particle
 * respawn window is what limits those).
 */
export const VISIBILITY_VERTEX_BODY = `
in vec2 a_uv;
// Elevation map rectangle (x0, y0, x1, y1), in the view's world copies.
uniform vec4 u_quad;
out vec4 v_clip;

void main() {
	vec2 pos = mix(u_quad.xy, u_quad.zw, a_uv);
	v_clip = projectPoint(vec2(pos.x + u_worldOffset, pos.y));
	gl_Position = vec4(a_uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const VISIBILITY_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec4 v_clip;
uniform sampler2D u_depth;
// glDepthRange (near, far) the surface depth was written with.
uniform vec2 u_depthRange;
out vec4 outColor;

// Tolerance between this evaluation and the rasterized surface depth, the
// same order as the point draws' bias.
const float VISIBILITY_EPS = 5e-5;

void main() {
	if (v_clip.w <= 0.0) {
		outColor = vec4(1.0);
		return;
	}
	vec3 ndc = v_clip.xyz / v_clip.w;
	if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 || abs(ndc.z) > 1.0) {
		outColor = vec4(1.0);
		return;
	}
	float depth = mix(u_depthRange.x, u_depthRange.y, ndc.z * 0.5 + 0.5);
	float stored = texture(u_depth, ndc.xy * 0.5 + 0.5).r;
	outColor = vec4(depth <= stored + VISIBILITY_EPS ? 1.0 : 0.0);
}
`;

/** A mercator-space visibility map of the terrain surface (0 hidden, 1 visible). */
export interface GpuVisibilityMap {
	texture: WebGLTexture;
	/** Same layout as GpuElevationMap.rect. */
	rect: [number, number, number, number];
}

/**
 * The raster mesh rectangle of a terrain draw for one world copy: the
 * elevation map's bounds shifted into the base world, clamped to it in x so
 * the copies tile the antimeridian strip without overlap.
 */
export const elevationQuad = (
	bounds: [number, number, number, number],
	offset: number
): [number, number, number, number] => [
	Math.max(0, bounds[0] - offset),
	bounds[1],
	Math.min(1, bounds[2] - offset),
	bounds[3]
];

/** Set the surface-mesh rectangle of one world copy (projectSurfacePoint). */
export const uploadSurfaceQuad = (
	gl: WebGL2RenderingContext,
	u: (name: string) => WebGLUniformLocation | null,
	elevation: GpuElevationMap,
	offset: number
): void => {
	gl.uniform4f(u('u_surfaceQuad'), ...elevationQuad(elevation.bounds, offset));
};

/** Bind the elevation map's texture (on `unit`) and rectangle uniforms. */
export const uploadElevationUniforms = (
	gl: WebGL2RenderingContext,
	u: (name: string) => WebGLUniformLocation | null,
	elevation: GpuElevationMap,
	unit: number
): void => {
	gl.activeTexture(gl.TEXTURE0 + unit);
	gl.bindTexture(gl.TEXTURE_2D, elevation.texture);
	gl.uniform1i(u('u_elevation'), unit);
	gl.uniform4f(u('u_elevationRect'), ...elevation.rect);
	gl.uniform1f(u('u_elevationScale'), elevation.scale);
	gl.uniform1f(u('u_surfaceN'), elevation.meshN);
};
