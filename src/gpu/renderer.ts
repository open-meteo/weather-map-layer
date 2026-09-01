/**
 * WebGL2 renderer core shared by the custom map layer (path B) and the GPU
 * tile renderer (path A). Owns the compiled program variants, the value/LUT
 * textures and the single draw routine; the two paths differ only in the
 * matrix they pass (map camera vs. per-tile ortho) and where the framebuffer
 * ends up (map canvas vs. OffscreenCanvas -> ImageBitmap).
 *
 * A draw takes 1..N layers (finest-first); a plain domain is the single-layer
 * case, a seamless composite passes one entry per active sub-domain.
 */
import { buildColorLut, colorLutKey } from './color-lut';
import type { GpuGridUniforms } from './grid-uniforms';
import {
	MISSING_SENTINEL,
	fragmentSource,
	layerUniformNames,
	shaderKey,
	vertexSource
} from './shader-source';
import type { FragmentShaderSpec, ProjectionShaderData } from './shader-source';

import type { Bounds, InterpolationMethod, RenderableColorScale } from '../types';

const LUT_SIZE_FROM_BAKE = 2048; // must match color-lut.ts LUT_SIZE

interface ProgramInfo {
	program: WebGLProgram;
	vao: WebGLVertexArrayObject;
	/** All active uniform locations, by name. */
	uniforms: Map<string, WebGLUniformLocation>;
	/** Mesh variants draw indexed triangles; the plain variant a quad strip. */
	indexCount: number;
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

export interface GpuLayerDraw {
	gridUniforms: GpuGridUniforms;
	valuesTexture: WebGLTexture;
	/** Smooth-step blend zone width in degrees; <= 0 disables edge blending. */
	blendWidthDeg?: number;
	/** NaN-distance texture (same grid layout as the values) refining the blend edge. */
	nanTexture?: WebGLTexture;
}

export interface GpuDrawOptions {
	/**
	 * Column-major 4x4 matrix mapping mercator [0..1] coordinates to clip space.
	 * Ignored when `projection` is set (the map's own projectTile runs instead).
	 */
	matrix?: ArrayLike<number>;
	/**
	 * MapLibre custom-layer projection support: the per-projection vertex prelude
	 * and its uniforms. Renders correctly on mercator, globe and the transition.
	 */
	projection?: {
		shaderData: ProjectionShaderData;
		data: GpuProjectionData;
	};
	/** Finest-first; a plain (non-seamless) domain passes exactly one. */
	layers: GpuLayerDraw[];
	interpolation: InterpolationMethod;
	/** Previous-timestep texture for in-shader temporal blending (single layer only). */
	prevTexture?: WebGLTexture;
	/** Blend factor: 0 = previous texture, 1 = current. Default 1. */
	mix?: number;
	lut: LutHandle;
	halfQuantum: number;
	opacity: number;
	/** Optional geographic clip bounds [west, south, east, north]. */
	clipBounds?: Bounds;
	/** Whole-world x offsets to draw (antimeridian copies). Default [0]. */
	worldOffsets?: number[];
	/** Quad in mercator space; defaults to the union of the layer quads. */
	quad?: [number, number, number, number];
}

/** Feature check for both GPU paths. */
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

export const layerSpecOf = (
	layer: GpuLayerDraw,
	isLast: boolean
): FragmentShaderSpec['layers'][number] => ({
	gridKind: layer.gridUniforms.gridKind,
	projectionName: layer.gridUniforms.projectionName,
	blends: !isLast && (layer.blendWidthDeg ?? 0) > 0,
	hasNanField: !isLast && (layer.blendWidthDeg ?? 0) > 0 && layer.nanTexture !== undefined
});

export class WeatherGpuRenderer {
	private gl: WebGL2RenderingContext;
	private programs = new Map<string, ProgramInfo>();
	private quadBuffer: WebGLBuffer | null = null;
	private meshBuffers: {
		vertices: WebGLBuffer;
		indices: WebGLBuffer;
		indexCount: number;
	} | null = null;

	// Value textures keyed by the source Float32Array identity: the protocol
	// state caches one array per variable/timestep, so identity is a stable key.
	private valueTextures = new Map<
		Float32Array,
		{ texture: WebGLTexture; nx: number; ny: number }
	>();
	private static readonly VALUE_TEXTURE_CACHE_MAX = 16;

	private lutTextures = new Map<string, LutHandle>();
	private static readonly LUT_CACHE_MAX = 8;

	constructor(gl: WebGL2RenderingContext) {
		this.gl = gl;
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
		// as a large finite sentinel instead. Also pads short arrays (gaussian
		// packing, defensive elsewhere) so texImage2D never reads out of bounds.
		const texels = nx * ny;
		const sanitized = new Float32Array(texels);
		const n = Math.min(values.length, texels);
		for (let i = 0; i < n; i++) {
			const v = values[i];
			sanitized[i] = Number.isFinite(v) ? v : MISSING_SENTINEL;
		}
		sanitized.fill(MISSING_SENTINEL, n);

		const texture = gl.createTexture();
		if (!texture) throw new Error('gpu: could not create value texture');
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, nx, ny, 0, gl.RED, gl.FLOAT, sanitized);

		this.valueTextures.set(values, { texture, nx, ny });
		if (this.valueTextures.size > WeatherGpuRenderer.VALUE_TEXTURE_CACHE_MAX) {
			const oldestKey = this.valueTextures.keys().next().value!;
			const oldest = this.valueTextures.get(oldestKey)!;
			gl.deleteTexture(oldest.texture);
			this.valueTextures.delete(oldestKey);
		}
		return texture;
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
		const layers = opts.layers;
		const spec: FragmentShaderSpec = {
			layers: layers.map((layer, i) => layerSpecOf(layer, i === layers.length - 1)),
			interpolation: opts.interpolation
		};
		const info = this.getProgram(spec, opts.projection?.shaderData);
		const u = (name: string): WebGLUniformLocation | null => info.uniforms.get(name) ?? null;

		gl.useProgram(info.program);
		gl.bindVertexArray(info.vao);

		// Texture unit assignment: per-layer values (+ optional nan field), then
		// the LUT and the single-layer temporal-blend texture.
		let unit = 0;
		const bindTexture = (name: string, texture: WebGLTexture): void => {
			gl.activeTexture(gl.TEXTURE0 + unit);
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.uniform1i(u(name), unit);
			unit++;
		};

		for (let i = 0; i < layers.length; i++) {
			const layer = layers[i];
			const g = layer.gridUniforms;
			const names = layerUniformNames(i);

			bindTexture(names.values, layer.valuesTexture);

			if (g.gridKind === 'gaussian') {
				gl.uniform4i(u(names.gauss), g.gauss[0], g.gauss[1], g.gauss[2], g.gauss[3]);
			} else {
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

			if (spec.layers[i].blends) {
				gl.uniform1f(u(names.blendWidth), layer.blendWidthDeg ?? 0);
				if (g.gridKind === 'projected' && g.edgeProj) {
					gl.uniform4f(
						u(names.edgeProj),
						g.edgeProj.minX,
						g.edgeProj.minY,
						g.edgeProj.nxM1,
						g.edgeProj.nyM1
					);
					gl.uniform2f(u(names.edgeDeg), g.edgeProj.degPerCol, g.edgeProj.degPerRow);
				} else {
					const [west, south, east, north] = g.fullBounds;
					gl.uniform4f(u(names.fullBounds), west, south, east, north);
				}
				if (spec.layers[i].hasNanField && layer.nanTexture) {
					bindTexture(names.nan, layer.nanTexture);
				}
			}
		}

		bindTexture('u_lut', opts.lut.texture);
		if (layers.length === 1) {
			bindTexture('u_valuesPrev', opts.prevTexture ?? layers[0].valuesTexture);
			gl.uniform1f(u('u_mix'), opts.prevTexture ? (opts.mix ?? 1) : 1);
		}

		const projection = opts.projection;
		if (projection) {
			const p = projection.data;
			gl.uniformMatrix4fv(u('u_projection_matrix'), false, p.mainMatrix as Float32List);
			gl.uniformMatrix4fv(
				u('u_projection_fallback_matrix'),
				false,
				p.fallbackMatrix as Float32List
			);
			gl.uniform4f(u('u_projection_tile_mercator_coords'), ...p.tileMercatorCoords);
			gl.uniform4f(u('u_projection_clipping_plane'), ...p.clippingPlane);
			gl.uniform1f(u('u_projection_transition'), p.projectionTransition);
		} else {
			gl.uniformMatrix4fv(u('u_matrix'), false, opts.matrix as Float32List);
		}
		const quad = opts.quad ?? unionQuad(layers.map((layer) => layer.gridUniforms.quad));
		gl.uniform4f(u('u_quad'), quad[0], quad[1], quad[2], quad[3]);

		gl.uniform4f(
			u('u_lutRange'),
			opts.lut.min,
			1 / (opts.lut.max - opts.lut.min),
			0.5 / LUT_SIZE_FROM_BAKE,
			1 - 1 / LUT_SIZE_FROM_BAKE
		);
		gl.uniform1f(u('u_halfQuantum'), opts.halfQuantum);
		gl.uniform1f(u('u_opacity'), opts.opacity);

		const clip = opts.clipBounds;
		if (clip) {
			gl.uniform4f(u('u_clipBounds'), clip[0], clip[1], clip[2], clip[3]);
		} else {
			gl.uniform4f(u('u_clipBounds'), -1e9, -1e9, 1e9, 1e9);
		}

		for (const offset of opts.worldOffsets ?? [0]) {
			gl.uniform1f(u('u_worldOffset'), offset);
			if (info.indexCount > 0) {
				gl.drawElements(gl.TRIANGLES, info.indexCount, gl.UNSIGNED_INT, 0);
			} else {
				gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			}
		}

		gl.bindVertexArray(null);
	}

	dispose(): void {
		const gl = this.gl;
		for (const { texture } of this.valueTextures.values()) gl.deleteTexture(texture);
		this.valueTextures.clear();
		for (const { texture } of this.lutTextures.values()) gl.deleteTexture(texture);
		this.lutTextures.clear();
		for (const { program, vao } of this.programs.values()) {
			gl.deleteProgram(program);
			gl.deleteVertexArray(vao);
		}
		this.programs.clear();
		if (this.quadBuffer) {
			gl.deleteBuffer(this.quadBuffer);
			this.quadBuffer = null;
		}
		if (this.meshBuffers) {
			gl.deleteBuffer(this.meshBuffers.vertices);
			gl.deleteBuffer(this.meshBuffers.indices);
			this.meshBuffers = null;
		}
	}

	private getQuadBuffer(): WebGLBuffer {
		if (this.quadBuffer) return this.quadBuffer;
		const gl = this.gl;
		const buffer = gl.createBuffer();
		if (!buffer) throw new Error('gpu: could not create quad buffer');
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
		this.quadBuffer = buffer;
		return buffer;
	}

	/**
	 * Subdivision of the quad for projectTile variants: the globe projection is
	 * non-linear, so the rectangle must be a mesh to curve around the sphere.
	 * 128 cells across the whole world keep the silhouette smooth at low zoom.
	 */
	private static readonly MESH_N = 128;

	private getMeshBuffers(): { vertices: WebGLBuffer; indices: WebGLBuffer; indexCount: number } {
		if (this.meshBuffers) return this.meshBuffers;
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

		this.meshBuffers = { vertices: vertexBuffer, indices: indexBuffer, indexCount: k };
		return this.meshBuffers;
	}

	private getProgram(spec: FragmentShaderSpec, shaderData?: ProjectionShaderData): ProgramInfo {
		const key = `${shaderKey(spec)}|${shaderData?.variantName ?? 'plain'}`;
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

		// Enumerate active uniforms: the per-layer uniform set varies per shader
		// variant, so a fixed name list would not fit.
		const uniforms = new Map<string, WebGLUniformLocation>();
		const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
		for (let i = 0; i < count; i++) {
			const active = gl.getActiveUniform(program, i);
			if (!active) continue;
			const location = gl.getUniformLocation(program, active.name);
			if (location) uniforms.set(active.name.replace(/\[0\]$/, ''), location);
		}

		const vao = gl.createVertexArray();
		if (!vao) throw new Error('gpu: could not create VAO');
		gl.bindVertexArray(vao);
		let indexCount = 0;
		if (shaderData) {
			const mesh = this.getMeshBuffers();
			gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vertices);
			gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices);
			indexCount = mesh.indexCount;
		} else {
			gl.bindBuffer(gl.ARRAY_BUFFER, this.getQuadBuffer());
		}
		const aUv = gl.getAttribLocation(program, 'a_uv');
		gl.enableVertexAttribArray(aUv);
		gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);

		const info: ProgramInfo = { program, vao, uniforms, indexCount };
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

/** Union of mercator quads (top-left / bottom-right convention). */
const unionQuad = (quads: [number, number, number, number][]): [number, number, number, number] => {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const [qx0, qy0, qx1, qy1] of quads) {
		x0 = Math.min(x0, qx0);
		y0 = Math.min(y0, qy0);
		x1 = Math.max(x1, qx1);
		y1 = Math.max(y1, qy1);
	}
	return [x0, y0, x1, y1];
};

/**
 * Column-major ortho matrix mapping the mercator box (x0..x1, y0..y1, y down)
 * to clip space with y0 at the top of the framebuffer — the per-tile "camera"
 * of the GPU tile renderer.
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
