/**
 * GPU tile renderer behind the existing tile pipeline: a raster tile is
 * rasterised by a WebGL2 fragment shader and handed over as an ImageBitmap,
 * exactly what the CPU pixel loop produces. It runs inside the tile worker
 * (see tile-queue.ts), so the map's main thread never issues GL work.
 *
 * The shader math is the GLSL port of the CPU grid lookup and interpolation
 * (shader-source.ts), so both rasterisers draw the same picture; the colour
 * scale is baked into a LUT texture (color-lut.ts). The per-tile "camera" is
 * an ortho matrix over the tile's mercator box.
 *
 * Rendering is asynchronous: `submit` draws into a pooled framebuffer and
 * fences it, `isFinished` polls the fence without blocking, and `finish`
 * turns the completed framebuffer into the ImageBitmap. Reading a result
 * before the fence signals would stall the worker until the GPU catches up,
 * which serialises the two and halves the throughput.
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
	DimensionRange,
	Domain,
	RenderOptions,
	RenderableColorScale,
	TileIndex
} from '../types';

export interface GpuTileRequest {
	tileIndex: TileIndex;
	/** Identifies the value array; the values themselves arrive once via `setValues`. */
	dataKey: string;
	scaleFactor?: number;
	ranges: DimensionRange[];
	domain: Domain;
	renderOptions: RenderOptions;
	/** Geographic clip bounds [west, south, east, north]; nothing is drawn outside. */
	clipBounds?: Bounds;
}

/** Thrown by `submit` when the renderer holds neither a texture nor values for the request's data key. */
export class MissingDataError extends Error {
	constructor(public readonly dataKey: string) {
		super(`gpu: no values for data key ${dataKey}`);
	}
}

/** A submitted tile: opaque to callers, released by `finish` or `release`. */
export interface GpuPendingTile {
	readonly target: RenderTarget;
	readonly sync: WebGLSync;
	readonly tileSize: number;
}

interface RenderTarget {
	framebuffer: WebGLFramebuffer;
	texture: WebGLTexture;
	size: number;
	busy: boolean;
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
 * True when this thread can create a WebGL2 context on an OffscreenCanvas.
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
	/** Tiles that may be in flight on the GPU at once; bounds the framebuffer pool. */
	static readonly MAX_IN_FLIGHT = 8;

	private canvas: OffscreenCanvas;
	private gl: WebGL2RenderingContext;
	private programs = new Map<string, ProgramInfo>();
	private quadVao: WebGLVertexArrayObject | null = null;
	private quadBuffer: WebGLBuffer | null = null;
	private targets: RenderTarget[] = [];
	private inFlightCount = 0;

	// Values wait here until the first tile needs them: the grid size that
	// decides the texture layout is only known from a request's ranges.
	private pendingValues = new Map<string, Float32Array>();

	// Value textures keyed by the data key the pool assigns per value array.
	// LRU-evicted by a byte budget so animation loops over many timesteps
	// cannot exhaust VRAM (a failed allocation samples as noise on real drivers).
	private valueTextures = new Map<
		string,
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

	get inFlight(): number {
		return this.inFlightCount;
	}

	get maxInFlight(): number {
		return GpuTileRenderer.MAX_IN_FLIGHT;
	}

	/** Hand over the values for a data key; ignored when its texture is already resident. */
	setValues(dataKey: string, values: Float32Array): void {
		if (!this.valueTextures.has(dataKey)) {
			this.pendingValues.set(dataKey, values);
		}
	}

	hasValues(dataKey: string): boolean {
		return this.valueTextures.has(dataKey) || this.pendingValues.has(dataKey);
	}

	/**
	 * Draw the tile into a pooled framebuffer and fence it. Returns null when
	 * every framebuffer is busy; the caller retries once one is finished.
	 * Throws MissingDataError when the values for the data key never arrived
	 * or were evicted.
	 */
	submit(request: GpuTileRequest): GpuPendingTile | null {
		if (this.inFlightCount >= GpuTileRenderer.MAX_IN_FLIGHT) return null;

		const { z, x, y } = request.tileIndex;
		const tileSize = request.renderOptions.tileSize;
		const gl = this.gl;

		const gridUniforms = computeGridUniforms(request.domain.grid, request.ranges);
		// Resolve everything that can fail before a framebuffer is taken
		const valuesTexture = this.getValueTexture(request.dataKey, gridUniforms.nx, gridUniforms.ny);
		const spec: FragmentShaderSpec = {
			layers: [{ gridKind: gridUniforms.gridKind, projectionName: gridUniforms.projectionName }],
			interpolation: request.renderOptions.interpolation
		};
		const info = this.getProgram(spec);
		const lut = this.getLut(request.renderOptions.colorScale, request.renderOptions.colorBlend);
		const target = this.acquireTarget(tileSize);
		const u = (name: string): WebGLUniformLocation | null => info.uniforms.get(name) ?? null;

		gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
		gl.viewport(0, 0, tileSize, tileSize);
		gl.disable(gl.BLEND); // opaque write of premultiplied colours into the tile
		gl.disable(gl.DEPTH_TEST);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);

		gl.useProgram(info.program);
		gl.bindVertexArray(this.getQuadVao());

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
		gl.uniform1f(u('u_halfQuantum'), computeHalfQuantum(request.scaleFactor));
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
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);

		const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
		if (!sync) {
			target.busy = false;
			throw new Error('gpu: could not create a fence');
		}
		// Without a flush the commands can sit in the queue until the next
		// blocking call, and the fence would never signal while we poll.
		gl.flush();
		this.inFlightCount++;
		return { target, sync, tileSize };
	}

	/** True once the GPU has finished drawing the tile; never blocks. */
	isFinished(pending: GpuPendingTile): boolean {
		const gl = this.gl;
		const status = gl.clientWaitSync(pending.sync, 0, 0);
		return status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED;
	}

	/** Copy the finished tile into the canvas and detach it as an ImageBitmap. */
	finish(pending: GpuPendingTile): ImageBitmap {
		const gl = this.gl;
		const size = pending.tileSize;
		if (this.canvas.width !== size || this.canvas.height !== size) {
			this.canvas.width = size;
			this.canvas.height = size;
		}
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, pending.target.framebuffer);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
		gl.blitFramebuffer(0, 0, size, size, 0, 0, size, size, gl.COLOR_BUFFER_BIT, gl.NEAREST);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
		this.release(pending);
		return this.canvas.transferToImageBitmap();
	}

	/** Drop a submitted tile without reading it (cancelled request). */
	release(pending: GpuPendingTile): void {
		if (!pending.target.busy) return;
		this.gl.deleteSync(pending.sync);
		pending.target.busy = false;
		this.inFlightCount--;
	}

	dispose(): void {
		const gl = this.gl;
		for (const target of this.targets) {
			gl.deleteFramebuffer(target.framebuffer);
			gl.deleteTexture(target.texture);
		}
		this.targets = [];
		this.inFlightCount = 0;
		this.pendingValues.clear();
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

	/** A free framebuffer of the tile size, reallocating an idle one when the size differs. */
	private acquireTarget(size: number): RenderTarget {
		const gl = this.gl;
		let target = this.targets.find((t) => !t.busy && t.size === size);
		if (!target) {
			target = this.targets.find((t) => !t.busy);
			if (target) {
				gl.deleteFramebuffer(target.framebuffer);
				gl.deleteTexture(target.texture);
				this.targets.splice(this.targets.indexOf(target), 1);
			}
			const texture = gl.createTexture();
			const framebuffer = gl.createFramebuffer();
			if (!texture || !framebuffer) throw new Error('gpu: could not create a render target');
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
			gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			target = { framebuffer, texture, size, busy: false };
			this.targets.push(target);
		}
		target.busy = true;
		return target;
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

	/** The R32F value texture for a data key, uploading the handed-over values on first use. */
	private getValueTexture(dataKey: string, nx: number, ny: number): WebGLTexture {
		const cached = this.valueTextures.get(dataKey);
		if (cached && cached.nx === nx && cached.ny === ny) {
			// Re-insert to keep insertion order as LRU order
			this.valueTextures.delete(dataKey);
			this.valueTextures.set(dataKey, cached);
			return cached.texture;
		}

		const values = this.pendingValues.get(dataKey);
		if (!values) throw new MissingDataError(dataKey);

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

		// The texture is the only copy kept; the pool re-sends the values
		// should the texture be evicted later.
		this.pendingValues.delete(dataKey);
		this.valueTextures.set(dataKey, { texture, nx, ny, bytes });
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
