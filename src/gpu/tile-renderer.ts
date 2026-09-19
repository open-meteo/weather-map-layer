/**
 * GPU tile renderer behind the existing tile pipeline: a raster tile is
 * rasterised by a WebGL2 fragment shader into an OffscreenCanvas and handed
 * over as an ImageBitmap, exactly what the CPU worker produces.
 *
 * The shader math is the GLSL port of the CPU grid lookup and interpolation
 * (shader-source.ts), so both rasterisers draw the same picture; the colour
 * scale is baked into a LUT texture (color-lut.ts). The per-tile "camera" is
 * an ortho matrix over the tile's mercator box. One shared GL context renders
 * every tile of the protocol, sequentially.
 */
import { halfQuantum as computeHalfQuantum } from '../utils/math';

import { LUT_SIZE, buildColorLut, colorLutKey } from './color-lut';
import { computeGridUniforms } from './grid-uniforms';
import type { GpuGridUniforms } from './grid-uniforms';
import {
	MISSING_SENTINEL,
	VERTEX_SOURCE,
	fragmentSource,
	layerUniformNames,
	shaderKey
} from './shader-source';
import type { FragmentShaderSpec } from './shader-source';

import type {
	Bounds,
	Data,
	DimensionRange,
	Domain,
	RenderOptions,
	RenderableColorScale,
	TileIndex
} from '../types';

export interface GpuTileRequest {
	tileIndex: TileIndex;
	data: Data;
	ranges: DimensionRange[];
	domain: Domain;
	renderOptions: RenderOptions;
	/** Geographic clip bounds [west, south, east, north]; nothing is drawn outside. */
	clipBounds?: Bounds;
}

interface ProgramInfo {
	program: WebGLProgram;
	/** All active uniform locations, by name. */
	uniforms: Map<string, WebGLUniformLocation>;
}

interface LutHandle {
	texture: WebGLTexture;
	min: number;
	max: number;
}

let gpuSupport: boolean | undefined;

/**
 * True when the page can create a WebGL2 context on an OffscreenCanvas.
 * Probed once: the answer does not change and the probe allocates a context.
 */
export const isGpuSupported = (): boolean => {
	if (gpuSupport === undefined) {
		gpuSupport = false;
		if (typeof OffscreenCanvas !== 'undefined') {
			try {
				gpuSupport = new OffscreenCanvas(1, 1).getContext('webgl2') !== null;
			} catch {
				gpuSupport = false;
			}
		}
	}
	return gpuSupport;
};

/**
 * Column-major ortho matrix mapping the mercator box (x0..x1, y0..y1, y down)
 * to clip space with y0 at the top of the framebuffer.
 */
export const mercatorBoxMatrix = (x0: number, y0: number, x1: number, y1: number): Float32Array => {
	const w = x1 - x0;
	const h = y1 - y0;
	// ndcX = 2 (mx - x0) / w - 1 ; ndcY = 1 - 2 (my - y0) / h
	// prettier-ignore
	return new Float32Array([
		2 / w, 0, 0, 0,
		0, -2 / h, 0, 0,
		0, 0, 1, 0,
		-1 - (2 * x0) / w, 1 + (2 * y0) / h, 0, 1
	]);
};

/** The quad's vertex attribute; bound to this location in every program. */
const A_UV_LOCATION = 0;

export class GpuTileRenderer {
	private canvas: OffscreenCanvas;
	private gl: WebGL2RenderingContext;
	private programs = new Map<string, ProgramInfo>();
	private quadVao: WebGLVertexArrayObject | null = null;
	private quadBuffer: WebGLBuffer | null = null;

	// Value textures keyed by the source Float32Array identity: the protocol
	// state caches one array per variable/timestep, so identity is a stable
	// key. LRU-evicted by a byte budget so animation loops over many timesteps
	// cannot exhaust VRAM (a failed allocation samples as noise on real drivers).
	private valueTextures = new Map<
		Float32Array,
		{ texture: WebGLTexture; nx: number; ny: number; bytes: number }
	>();
	private valueTextureBytes = 0;
	static readonly VALUE_TEXTURE_BUDGET_BYTES = 256 * 1024 * 1024;

	private lutTextures = new Map<string, LutHandle>();
	private static readonly LUT_CACHE_MAX = 8;

	constructor() {
		this.canvas = new OffscreenCanvas(1, 1);
		const gl = this.canvas.getContext('webgl2', {
			// The shader outputs premultiplied alpha (like every canvas compositor
			// expects); no depth/stencil needed for a full-tile quad.
			premultipliedAlpha: true,
			alpha: true,
			depth: false,
			stencil: false,
			antialias: false
		});
		if (!gl) {
			throw new Error('gpu: could not create a WebGL2 context');
		}
		this.gl = gl;
	}

	renderTile(request: GpuTileRequest): ImageBitmap {
		const { z, x, y } = request.tileIndex;
		const tileSize = request.renderOptions.tileSize;
		const values = request.data.values;
		if (!values) {
			throw new Error('gpu: no values provided');
		}

		const gl = this.gl;
		if (this.canvas.width !== tileSize || this.canvas.height !== tileSize) {
			this.canvas.width = tileSize;
			this.canvas.height = tileSize;
		}

		const gridUniforms = computeGridUniforms(request.domain.grid, request.ranges);
		const spec: FragmentShaderSpec = {
			layers: [{ gridKind: gridUniforms.gridKind, projectionName: gridUniforms.projectionName }],
			interpolation: request.renderOptions.interpolation
		};
		const info = this.getProgram(spec);
		const u = (name: string): WebGLUniformLocation | null => info.uniforms.get(name) ?? null;

		gl.viewport(0, 0, tileSize, tileSize);
		gl.disable(gl.BLEND); // opaque write of premultiplied colours into the tile
		gl.disable(gl.DEPTH_TEST);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);

		gl.useProgram(info.program);
		gl.bindVertexArray(this.getQuadVao());

		const valuesTexture = this.getValueTexture(values, gridUniforms.nx, gridUniforms.ny);
		const lut = this.getLut(request.renderOptions.colorScale, request.renderOptions.colorBlend);
		let unit = 0;
		const bindTexture = (name: string, texture: WebGLTexture): void => {
			gl.activeTexture(gl.TEXTURE0 + unit);
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.uniform1i(u(name), unit);
			unit++;
		};

		const names = layerUniformNames(0);
		bindTexture(names.values, valuesTexture);
		this.uploadGridUniforms(u, names, gridUniforms);
		bindTexture('u_lut', lut.texture);
		// A single layer always compiles the temporal path: the previous-timestep
		// texture is the current one and the mix is 1, i.e. no blending.
		bindTexture('u_valuesPrev', valuesTexture);
		gl.uniform1f(u('u_mix'), 1);

		// Tile (z, x, y) covers mercator x in [x, x+1]/2^z, y in [y, y+1]/2^z.
		const worldTiles = Math.pow(2, z);
		const matrix = mercatorBoxMatrix(
			x / worldTiles,
			y / worldTiles,
			(x + 1) / worldTiles,
			(y + 1) / worldTiles
		);
		gl.uniformMatrix4fv(u('u_matrix'), false, matrix);
		gl.uniform4f(
			u('u_lutRange'),
			lut.min,
			1 / (lut.max - lut.min),
			0.5 / LUT_SIZE,
			1 - 1 / LUT_SIZE
		);
		gl.uniform1f(u('u_halfQuantum'), computeHalfQuantum(request.data.scaleFactor));
		gl.uniform1f(u('u_opacity'), 1);

		const clip = request.clipBounds;
		if (clip) {
			gl.uniform4f(u('u_clipBounds'), clip[0], clip[1], clip[2], clip[3]);
		} else {
			gl.uniform4f(u('u_clipBounds'), -1e9, -1e9, 1e9, 1e9);
		}

		const quad = gridUniforms.quad;
		gl.uniform4f(u('u_quad'), quad[0], quad[1], quad[2], quad[3]);
		gl.uniform1f(u('u_worldOffset'), 0);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.bindVertexArray(null);

		return this.canvas.transferToImageBitmap();
	}

	dispose(): void {
		const gl = this.gl;
		for (const { texture } of this.valueTextures.values()) gl.deleteTexture(texture);
		this.valueTextures.clear();
		this.valueTextureBytes = 0;
		for (const { texture } of this.lutTextures.values()) gl.deleteTexture(texture);
		this.lutTextures.clear();
		for (const { program } of this.programs.values()) gl.deleteProgram(program);
		this.programs.clear();
		if (this.quadVao) {
			gl.deleteVertexArray(this.quadVao);
			this.quadVao = null;
		}
		if (this.quadBuffer) {
			gl.deleteBuffer(this.quadBuffer);
			this.quadBuffer = null;
		}
	}

	/** One layer's grid-geometry uniforms: everything the generated sampler reads besides the value texture. */
	private uploadGridUniforms(
		u: (name: string) => WebGLUniformLocation | null,
		names: ReturnType<typeof layerUniformNames>,
		g: GpuGridUniforms
	): void {
		const gl = this.gl;
		if (g.gridKind === 'gaussian') {
			gl.uniform4i(u(names.gauss), g.gauss[0], g.gauss[1], g.gauss[2], g.gauss[3]);
			return;
		}
		gl.uniform2i(u(names.n), g.nx, g.ny);
		gl.uniform2f(u(names.origin), g.originX, g.originY);
		gl.uniform2f(u(names.delta), g.dx, g.dy);
		if (g.gridKind === 'projected') {
			gl.uniform4f(u(names.projA), g.projA[0], g.projA[1], g.projA[2], g.projA[3]);
			gl.uniform4f(u(names.projB), g.projB[0], g.projB[1], g.projB[2], g.projB[3]);
		} else {
			gl.uniform2i(u(names.flags), g.lonWrap ? 1 : 0, g.wrapLastCellDouble ? 1 : 0);
		}
	}

	/** Upload (or reuse) the R32F value texture for a data array. */
	private getValueTexture(values: Float32Array, nx: number, ny: number): WebGLTexture {
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
		// as a large finite sentinel instead. Also pads short arrays (gaussian
		// packing) so texImage2D never reads out of bounds.
		const texels = nx * ny;
		const sanitized = new Float32Array(texels);
		const n = Math.min(values.length, texels);
		for (let i = 0; i < n; i++) {
			const v = values[i];
			sanitized[i] = Number.isFinite(v) ? v : MISSING_SENTINEL;
		}
		sanitized.fill(MISSING_SENTINEL, n);

		const bytes = texels * 4;
		this.evictValueTextures(GpuTileRenderer.VALUE_TEXTURE_BUDGET_BYTES - bytes);

		let texture = this.uploadValueTexture(nx, ny, sanitized);
		if (!texture) {
			// Allocation failed (VRAM exhausted): drop the whole cache and retry
			// once, corrupt sampling from a failed allocation must never persist.
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

	/** Evict least-recently-used value textures until at most `targetBytes` remain. */
	private evictValueTextures(targetBytes: number): void {
		const gl = this.gl;
		for (const [key, entry] of this.valueTextures) {
			if (this.valueTextureBytes <= Math.max(0, targetBytes)) break;
			gl.deleteTexture(entry.texture);
			this.valueTextureBytes -= entry.bytes;
			this.valueTextures.delete(key);
		}
	}

	/** Bake (or reuse) the colour LUT texture for a scale. */
	private getLut(scale: RenderableColorScale, blend: boolean): LutHandle {
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
		if (this.lutTextures.size > GpuTileRenderer.LUT_CACHE_MAX) {
			const oldestKey = this.lutTextures.keys().next().value!;
			gl.deleteTexture(this.lutTextures.get(oldestKey)!.texture);
			this.lutTextures.delete(oldestKey);
		}
		return handle;
	}

	private getQuadVao(): WebGLVertexArrayObject {
		if (this.quadVao) return this.quadVao;
		const gl = this.gl;
		const buffer = gl.createBuffer();
		const vao = gl.createVertexArray();
		if (!buffer || !vao) throw new Error('gpu: could not create the quad geometry');
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
		gl.enableVertexAttribArray(A_UV_LOCATION);
		gl.vertexAttribPointer(A_UV_LOCATION, 2, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);
		this.quadBuffer = buffer;
		this.quadVao = vao;
		return vao;
	}

	private getProgram(spec: FragmentShaderSpec): ProgramInfo {
		const key = shaderKey(spec);
		const cached = this.programs.get(key);
		if (cached) return cached;

		const gl = this.gl;
		const program = gl.createProgram();
		if (!program) throw new Error('gpu: could not create program');
		gl.attachShader(program, this.compile(gl.VERTEX_SHADER, VERTEX_SOURCE));
		gl.attachShader(program, this.compile(gl.FRAGMENT_SHADER, fragmentSource(spec)));
		gl.bindAttribLocation(program, A_UV_LOCATION, 'a_uv');
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			const log = gl.getProgramInfoLog(program);
			gl.deleteProgram(program);
			throw new Error(`gpu: program link failed: ${log}`);
		}

		// Enumerate active uniforms: the uniform set varies per shader variant,
		// so a fixed name list would not fit.
		const uniforms = new Map<string, WebGLUniformLocation>();
		const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
		for (let i = 0; i < count; i++) {
			const active = gl.getActiveUniform(program, i);
			if (!active) continue;
			const location = gl.getUniformLocation(program, active.name);
			if (location) uniforms.set(active.name.replace(/\[0\]$/, ''), location);
		}

		const info: ProgramInfo = { program, uniforms };
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

let sharedRenderer: GpuTileRenderer | undefined;

/** Lazily created shared renderer: one GL context renders all protocol tiles. */
export const getSharedTileRenderer = (): GpuTileRenderer => {
	if (!sharedRenderer) {
		sharedRenderer = new GpuTileRenderer();
	}
	return sharedRenderer;
};
