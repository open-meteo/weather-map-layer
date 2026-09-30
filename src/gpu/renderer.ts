/**
 * WebGL2 renderer core of the custom map layer. Owns the compiled program
 * variants, the value/LUT textures and the single draw routine. One renderer
 * is shared by every WeatherGpuLayer on a GL context (see layer.ts).
 */
import { LUT_SIZE, buildColorLut, colorLutKey } from './color-lut';
import type { GpuGridUniforms } from './grid-uniforms';
import {
	GRID_UNIFORM_NAMES,
	MISSING_SENTINEL,
	fragmentSource,
	shaderKey,
	vertexSource
} from './shader-source';
import type { FragmentShaderSpec, ProjectionShaderData } from './shader-source';

import type { InterpolationMethod, RenderableColorScale } from '../types';

interface ProgramInfo {
	program: WebGLProgram;
	vao: WebGLVertexArrayObject;
	/** All active uniform locations, by name. */
	uniforms: Map<string, WebGLUniformLocation>;
}

/**
 * The projection uniforms of CustomRenderMethodInput['defaultProjectionData'],
 * feeding the prelude's `projectTile` (mercator, globe and the transition).
 */
export interface GpuProjectionData {
	mainMatrix: ArrayLike<number>;
	fallbackMatrix: ArrayLike<number>;
	tileMercatorCoords: [number, number, number, number];
	clippingPlane: [number, number, number, number];
	projectionTransition: number;
}

export interface LutHandle {
	texture: WebGLTexture;
	min: number;
	max: number;
}

export interface GpuDrawOptions {
	/**
	 * MapLibre custom-layer projection support: the per-projection vertex prelude
	 * and its uniforms. Renders correctly on mercator, globe and the transition.
	 */
	projection: {
		shaderData: ProjectionShaderData;
		data: GpuProjectionData;
	};
	gridUniforms: GpuGridUniforms;
	valuesTexture: WebGLTexture;
	interpolation: InterpolationMethod;
	lut: LutHandle;
	halfQuantum: number;
	opacity: number;
	/** Whole-world x offsets to draw (antimeridian copies). */
	worldOffsets: number[];
}

/** Feature check for the GPU layer. */
export const isGpuSupported = (): boolean => {
	if (typeof OffscreenCanvas === 'undefined') return false;
	try {
		const canvas = new OffscreenCanvas(1, 1);
		const gl = canvas.getContext('webgl2');
		return gl !== null;
	} catch {
		return false;
	}
};

/**
 * Upload the grid-geometry uniforms (everything the generated sampler reads
 * except the value texture itself, which the caller binds).
 */
const uploadGridLayerUniforms = (
	gl: WebGL2RenderingContext,
	u: (name: string) => WebGLUniformLocation | null,
	g: GpuGridUniforms
): void => {
	const names = GRID_UNIFORM_NAMES;
	gl.uniform2i(u(names.n), g.nx, g.ny);
	gl.uniform2f(u(names.origin), g.originX, g.originY);
	gl.uniform2f(u(names.delta), g.dx, g.dy);
	gl.uniform2i(u(names.flags), g.lonWrap ? 1 : 0, g.wrapLastCellDouble ? 1 : 0);
};

export class WeatherGpuRenderer {
	private gl: WebGL2RenderingContext;
	private programs = new Map<string, ProgramInfo>();
	private mesh: { vertices: WebGLBuffer; indices: WebGLBuffer; indexCount: number } | null = null;

	// Value textures keyed by the source Float32Array identity: the protocol
	// state caches one array per variable/timestep, so identity is a stable key.
	// LRU-evicted by a byte budget: at global views a single 0.25° texture is
	// ~4 MB, and an unbounded count would exhaust VRAM during animation loops
	// (failed allocations sample as uninitialised-memory noise on real drivers).
	private valueTextures = new Map<
		Float32Array,
		{ texture: WebGLTexture; nx: number; ny: number; bytes: number }
	>();
	private valueTextureBytes = 0;
	private valueTextureBudget: number;
	static readonly DEFAULT_TEXTURE_CACHE_MB = 256;

	private lutTextures = new Map<string, LutHandle>();
	private static readonly LUT_CACHE_MAX = 8;

	constructor(gl: WebGL2RenderingContext, options: { textureCacheMb?: number } = {}) {
		this.gl = gl;
		this.valueTextureBudget =
			(options.textureCacheMb ?? WeatherGpuRenderer.DEFAULT_TEXTURE_CACHE_MB) * 1024 * 1024;
	}

	/** Bytes of cached value textures, the configured budget, and the count. */
	getMemoryUsage(): { bytes: number; budgetBytes: number; textures: number } {
		return {
			bytes: this.valueTextureBytes,
			budgetBytes: this.valueTextureBudget,
			textures: this.valueTextures.size
		};
	}

	/** Raise (never lower below use) the value-texture budget at runtime. */
	setTextureBudget(mb: number): void {
		this.valueTextureBudget = Math.max(this.valueTextureBudget, mb * 1024 * 1024);
	}

	/** True when a texture for this value array is resident in VRAM. */
	hasValueTexture(values: Float32Array): boolean {
		return this.valueTextures.has(values);
	}

	/** Upload (or reuse) the R32F value texture for a data array. */
	getValueTexture(values: Float32Array, nx: number, ny: number): WebGLTexture {
		const cached = this.valueTextures.get(values);
		if (cached && cached.nx === nx && cached.ny === ny) {
			// Re-insert to keep insertion order as LRU order
			this.valueTextures.delete(values);
			this.valueTextures.set(values, cached);
			return cached.texture;
		}

		const gl = this.gl;
		const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
		if (nx > maxSize || ny > maxSize) {
			throw new Error(`gpu: grid ${nx}x${ny} exceeds MAX_TEXTURE_SIZE ${maxSize}`);
		}

		// NaN behaviour in float textures varies per driver: encode missing values
		// as a large finite sentinel instead. Also pads short arrays so texImage2D
		// never reads out of bounds.
		const texels = nx * ny;
		const sanitized = new Float32Array(texels);
		const n = Math.min(values.length, texels);
		for (let i = 0; i < n; i++) {
			const v = values[i];
			sanitized[i] = Number.isFinite(v) ? v : MISSING_SENTINEL;
		}
		sanitized.fill(MISSING_SENTINEL, n);

		const bytes = texels * 4;
		// Evict to budget before allocating (never evicting what a current draw
		// uses: everything a draw binds it fetched via this call in the same
		// frame, so those entries are the most recent).
		this.evictValueTextures(this.valueTextureBudget - bytes);

		let texture = this.uploadValueTexture(nx, ny, sanitized);
		if (!texture) {
			// Allocation failed (VRAM exhausted): drop the whole cache and retry
			// once — corrupt sampling from a failed allocation must never persist.
			this.evictValueTextures(0);
			texture = this.uploadValueTexture(nx, ny, sanitized);
			if (!texture) throw new Error(`gpu: value texture allocation failed (${nx}x${ny})`);
		}

		this.valueTextures.set(values, { texture, nx, ny, bytes });
		this.valueTextureBytes += bytes;
		return texture;
	}

	private uploadValueTexture(nx: number, ny: number, data: Float32Array): WebGLTexture | null {
		const gl = this.gl;
		const texture = gl.createTexture();
		if (!texture) return null;
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		// Flush pending errors so the check below attributes to this upload.
		gl.getError();
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, nx, ny, 0, gl.RED, gl.FLOAT, data);
		if (gl.getError() !== gl.NO_ERROR) {
			gl.deleteTexture(texture);
			return null;
		}
		return texture;
	}

	/**
	 * A cross-fade fetches the outgoing and the incoming frame's textures one
	 * after another in the same frame; both must survive eviction or the second
	 * fetch could delete the texture the first draw is using. (targetBytes 0 =
	 * full clear.)
	 */
	private static readonly MIN_RESIDENT_TEXTURES = 2;

	/** Evict least-recently-used value textures until at most `targetBytes` remain. */
	private evictValueTextures(targetBytes: number): void {
		const gl = this.gl;
		const keepCount = targetBytes <= 0 ? 0 : WeatherGpuRenderer.MIN_RESIDENT_TEXTURES;
		for (const [key, entry] of this.valueTextures) {
			if (this.valueTextureBytes <= Math.max(0, targetBytes)) break;
			if (this.valueTextures.size <= keepCount) break;
			gl.deleteTexture(entry.texture);
			this.valueTextureBytes -= entry.bytes;
			this.valueTextures.delete(key);
		}
	}

	/** Bake (or reuse) the colour LUT texture for a scale. */
	getLut(scale: RenderableColorScale, blend: boolean): LutHandle {
		const key = colorLutKey(scale, blend);
		const cached = this.lutTextures.get(key);
		if (cached) {
			this.lutTextures.delete(key);
			this.lutTextures.set(key, cached);
			return cached;
		}

		const gl = this.gl;
		const lut = buildColorLut(scale, blend);
		const texture = gl.createTexture();
		if (!texture) throw new Error('gpu: could not create LUT texture');
		const filter = blend ? gl.LINEAR : gl.NEAREST;
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texImage2D(
			gl.TEXTURE_2D,
			0,
			gl.RGBA,
			lut.data.length / 4,
			1,
			0,
			gl.RGBA,
			gl.UNSIGNED_BYTE,
			lut.data
		);

		const handle: LutHandle = { texture, min: lut.min, max: lut.max };
		this.lutTextures.set(key, handle);
		if (this.lutTextures.size > WeatherGpuRenderer.LUT_CACHE_MAX) {
			const oldestKey = this.lutTextures.keys().next().value!;
			gl.deleteTexture(this.lutTextures.get(oldestKey)!.texture);
			this.lutTextures.delete(oldestKey);
		}
		return handle;
	}

	draw(opts: GpuDrawOptions): void {
		const gl = this.gl;
		const spec: FragmentShaderSpec = { interpolation: opts.interpolation };
		const info = this.getProgram(spec, opts.projection.shaderData);
		const u = (name: string): WebGLUniformLocation | null => info.uniforms.get(name) ?? null;

		gl.useProgram(info.program);
		gl.bindVertexArray(info.vao);

		// Texture unit assignment: the values, then the LUT.
		let unit = 0;
		const bindTexture = (name: string, texture: WebGLTexture): void => {
			gl.activeTexture(gl.TEXTURE0 + unit);
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.uniform1i(u(name), unit);
			unit++;
		};

		bindTexture(GRID_UNIFORM_NAMES.values, opts.valuesTexture);
		uploadGridLayerUniforms(gl, u, opts.gridUniforms);
		bindTexture('u_lut', opts.lut.texture);

		const p = opts.projection.data;
		gl.uniformMatrix4fv(u('u_projection_matrix'), false, p.mainMatrix as Float32List);
		gl.uniformMatrix4fv(u('u_projection_fallback_matrix'), false, p.fallbackMatrix as Float32List);
		gl.uniform4f(u('u_projection_tile_mercator_coords'), ...p.tileMercatorCoords);
		gl.uniform4f(u('u_projection_clipping_plane'), ...p.clippingPlane);
		gl.uniform1f(u('u_projection_transition'), p.projectionTransition);

		gl.uniform4f(
			u('u_lutRange'),
			opts.lut.min,
			1 / (opts.lut.max - opts.lut.min),
			0.5 / LUT_SIZE,
			1 - 1 / LUT_SIZE
		);
		gl.uniform1f(u('u_halfQuantum'), opts.halfQuantum);
		gl.uniform1f(u('u_opacity'), opts.opacity);

		const quad = opts.gridUniforms.quad;
		gl.uniform4f(u('u_quad'), quad[0], quad[1], quad[2], quad[3]);
		for (const offset of opts.worldOffsets) {
			gl.uniform1f(u('u_worldOffset'), offset);
			gl.drawElements(gl.TRIANGLES, this.getMeshBuffers().indexCount, gl.UNSIGNED_INT, 0);
		}

		gl.bindVertexArray(null);
	}

	dispose(): void {
		const gl = this.gl;
		for (const { texture } of this.valueTextures.values()) gl.deleteTexture(texture);
		this.valueTextures.clear();
		this.valueTextureBytes = 0;
		for (const { texture } of this.lutTextures.values()) gl.deleteTexture(texture);
		this.lutTextures.clear();
		for (const { program, vao } of this.programs.values()) {
			gl.deleteProgram(program);
			gl.deleteVertexArray(vao);
		}
		this.programs.clear();
		if (this.mesh) {
			gl.deleteBuffer(this.mesh.vertices);
			gl.deleteBuffer(this.mesh.indices);
			this.mesh = null;
		}
	}

	/**
	 * Subdivision of the quad for projectTile variants: the globe projection is
	 * non-linear, so the rectangle must be a mesh to curve around the sphere.
	 * 128 cells across the whole world keep the silhouette smooth at low zoom.
	 */
	private static readonly MESH_N = 128;

	private getMeshBuffers(): { vertices: WebGLBuffer; indices: WebGLBuffer; indexCount: number } {
		if (this.mesh) return this.mesh;
		const gl = this.gl;
		const n = WeatherGpuRenderer.MESH_N;

		const vertices = new Float32Array((n + 1) * (n + 1) * 2);
		let k = 0;
		for (let j = 0; j <= n; j++) {
			for (let i = 0; i <= n; i++) {
				vertices[k++] = i / n;
				vertices[k++] = j / n;
			}
		}
		const indices = new Uint32Array(n * n * 6);
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
		if (!vertexBuffer || !indexBuffer) throw new Error('gpu: could not create mesh buffers');
		gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

		this.mesh = { vertices: vertexBuffer, indices: indexBuffer, indexCount: k };
		return this.mesh;
	}

	private getProgram(spec: FragmentShaderSpec, shaderData: ProjectionShaderData): ProgramInfo {
		const key = `${shaderKey(spec)}|${shaderData.variantName}`;
		const cached = this.programs.get(key);
		if (cached) return cached;

		const gl = this.gl;
		const program = gl.createProgram();
		if (!program) throw new Error('gpu: could not create program');
		gl.attachShader(program, this.compile(gl.VERTEX_SHADER, vertexSource(shaderData)));
		gl.attachShader(program, this.compile(gl.FRAGMENT_SHADER, fragmentSource(spec)));
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			const log = gl.getProgramInfoLog(program);
			gl.deleteProgram(program);
			throw new Error(`gpu: program link failed: ${log}`);
		}

		// Enumerate active uniforms: the prelude's uniform set varies per
		// projection variant, so a fixed name list would not fit.
		const uniforms = new Map<string, WebGLUniformLocation>();
		const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
		for (let i = 0; i < count; i++) {
			const active = gl.getActiveUniform(program, i);
			if (!active) continue;
			const location = gl.getUniformLocation(program, active.name);
			if (location) uniforms.set(active.name.replace(/\[0\]$/, ''), location);
		}

		// The program's VAO over the shared mesh.
		const vao = gl.createVertexArray();
		if (!vao) throw new Error('gpu: could not create VAO');
		gl.bindVertexArray(vao);
		const mesh = this.getMeshBuffers();
		gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vertices);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices);
		const aUv = gl.getAttribLocation(program, 'a_uv');
		gl.enableVertexAttribArray(aUv);
		gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);

		const info: ProgramInfo = { program, vao, uniforms };
		this.programs.set(key, info);
		return info;
	}

	private compile(type: number, source: string): WebGLShader {
		const gl = this.gl;
		const shader = gl.createShader(type);
		if (!shader) throw new Error('gpu: could not create shader');
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			const log = gl.getShaderInfoLog(shader);
			gl.deleteShader(shader);
			throw new Error(`gpu: shader compile failed: ${log}\n${source}`);
		}
		return shader;
	}
}
