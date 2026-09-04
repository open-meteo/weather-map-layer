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
import type { ResolvedClippingOptions } from '../utils/clipping';

import {
	ARROW_FRAGMENT_SOURCE,
	ARROW_INSTANCE_FLOATS,
	ARROW_TEMPLATE,
	arrowVertexSource
} from './arrows';
import { rasterizeClipMask } from './clip-mask';
import { buildColorLut, colorLutKey } from './color-lut';
import type { GpuGridUniforms } from './grid-uniforms';
import {
	MISSING_SENTINEL,
	fragmentSource,
	layerUniformNames,
	shaderKey,
	vertexSource
} from './shader-source';
import type { FragmentShaderSpec, LayerShaderSpec, ProjectionShaderData } from './shader-source';

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
 * A layer's uploaded arrow instances: the renderer can be shared by several
 * layers on one GL context, so this state lives with the layer. VAOs are
 * cached per projection variant.
 */
export interface ArrowInstances {
	buffer: WebGLBuffer;
	capacityBytes: number;
	count: number;
	vaos: Map<string, WebGLVertexArrayObject>;
}

/** Host styling for the in-shader contour isolines. */
export interface GpuContourStyle {
	/** Line RGB 0..1 (plain black or white in practice). */
	color: [number, number, number];
	/** Alpha per modulo class: other, ×moduli[0], ×moduli[1], ×moduli[2]. */
	classAlphas: [number, number, number, number];
	/** Line width in px per modulo class. */
	classWidths: [number, number, number, number];
	/** Level divisors that upgrade a line's class (ascending), e.g. 10/50/100. */
	moduli: [number, number, number];
}

/** A draw's contour pass: the style plus the levels of this request. */
export interface GpuContourDraw extends GpuContourStyle {
	/** Lines at every multiple of this step; 0 when `levels` is explicit. */
	step: number;
	/** Explicit levels (at most 48), e.g. the colour-scale breakpoints. */
	levels: number[];
	/** Smallest level spacing, for the crowding fade. */
	minGap: number;
	opacity: number;
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

/** An uploaded polygon clip mask (see clip-mask.ts). */
export interface GpuClipMask {
	texture: WebGLTexture;
	/** (x0, y0, 1/w, 1/h) of the mask rectangle in mercator [0..1] space. */
	rect: [number, number, number, number];
}

export interface GpuLayerDraw {
	gridUniforms: GpuGridUniforms;
	valuesTexture: WebGLTexture;
	/** Smooth-step blend zone width in degrees; <= 0 disables edge blending. */
	blendWidthDeg?: number;
	/** NaN-distance texture (same grid layout as the values) refining the blend edge. */
	nanTexture?: WebGLTexture;
	/**
	 * Previous-timestep values on the same grid. When every layer of a
	 * multi-layer draw carries one, the whole composite blends temporally by
	 * `mix` (single-layer draws use GpuDrawOptions.prevTexture instead).
	 */
	prevTexture?: WebGLTexture;
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
	/**
	 * Wind-advected temporal blend (single layer): eastward/northward wind
	 * component textures (m/s) plus the upstream/downstream displacement
	 * scales in degrees per m/s (mix and 1-mix times the timestep interval).
	 */
	advect?: { uTexture: WebGLTexture; vTexture: WebGLTexture; prevDeg: number; nextDeg: number };
	lut: LutHandle;
	halfQuantum: number;
	opacity: number;
	/** Optional geographic clip bounds [west, south, east, north]. */
	clipBounds?: Bounds;
	/** Optional polygon clip mask multiplied into the output. */
	clipMask?: GpuClipMask;
	/** Whole-world x offsets to draw (antimeridian copies). Default [0]. */
	worldOffsets?: number[];
	/** Quad in mercator space; defaults to the union of the layer quads. */
	quad?: [number, number, number, number];
	/** Isoline pass over the value field (set opacity 0 for a lines-only draw). */
	contours?: GpuContourDraw;
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
	layer: Pick<GpuLayerDraw, 'gridUniforms' | 'blendWidthDeg' | 'nanTexture'>,
	isLast: boolean
): FragmentShaderSpec['layers'][number] => ({
	gridKind: layer.gridUniforms.gridKind,
	projectionName: layer.gridUniforms.projectionName,
	blends: !isLast && (layer.blendWidthDeg ?? 0) > 0,
	hasNanField: !isLast && (layer.blendWidthDeg ?? 0) > 0 && layer.nanTexture !== undefined
});

/**
 * Upload one layer's grid-geometry and edge-blend uniforms (everything the
 * generated sampling functions read except the value texture itself, which the
 * caller binds under its own name). Shared by the raster draw and the
 * particle-update pass.
 */
export const uploadGridLayerUniforms = (
	gl: WebGL2RenderingContext,
	u: (name: string) => WebGLUniformLocation | null,
	i: number,
	spec: LayerShaderSpec,
	layer: Pick<GpuLayerDraw, 'gridUniforms' | 'blendWidthDeg' | 'nanTexture'>,
	bindTexture: (name: string, texture: WebGLTexture) => void
): void => {
	const g = layer.gridUniforms;
	const names = layerUniformNames(i);

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

	if (spec.blends) {
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
		if (spec.hasNanField && layer.nanTexture) {
			bindTexture(names.nan, layer.nanTexture);
		}
	}
};

export class WeatherGpuRenderer {
	private gl: WebGL2RenderingContext;
	private programs = new Map<string, ProgramInfo>();
	private quadBuffer: WebGLBuffer | null = null;
	private meshBuffers: {
		vertices: WebGLBuffer;
		indices: WebGLBuffer;
		indexCount: number;
	} | null = null;

	private arrowPrograms = new Map<
		string,
		{ program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation> }
	>();
	private arrowTemplateBuffer: WebGLBuffer | null = null;

	// Value textures keyed by the source Float32Array identity: the protocol
	// state caches one array per variable/timestep, so identity is a stable key.
	// LRU-evicted by a byte budget: at global views a single O1280 texture is
	// ~26 MB, and an unbounded count would exhaust VRAM during animation loops
	// (failed allocations sample as uninitialised-memory noise on real drivers).
	private valueTextures = new Map<
		Float32Array,
		{ texture: WebGLTexture; nx: number; ny: number; bytes: number; label?: string }
	>();
	/** URL-state key -> value array, for residency queries that outlive the RAM state. */
	private textureLabels = new Map<string, Float32Array>();
	private valueTextureBytes = 0;
	private valueTextureBudget: number;
	static readonly DEFAULT_TEXTURE_CACHE_MB = 256;

	private lutTextures = new Map<string, LutHandle>();
	private static readonly LUT_CACHE_MAX = 8;

	// Clip masks keyed by the resolved clipping identity (parse-request caches
	// one resolution per options object, so identity is stable across frames).
	private clipMasks = new Map<ResolvedClippingOptions, GpuClipMask | undefined>();
	private static readonly CLIP_MASK_CACHE_MAX = 2;

	private contourLevelScratch = new Float32Array(48);

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

	/** True when a texture labelled with this URL-state key is resident. */
	hasTextureForLabel(label: string): boolean {
		const values = this.textureLabels.get(label);
		return values !== undefined && this.valueTextures.has(values);
	}

	/** Upload (or reuse) the R32F value texture for a data array. */
	getValueTexture(values: Float32Array, nx: number, ny: number, label?: string): WebGLTexture {
		const cached = this.valueTextures.get(values);
		if (cached && cached.nx === nx && cached.ny === ny) {
			// Re-insert to keep insertion order as LRU order
			this.valueTextures.delete(values);
			this.valueTextures.set(values, cached);
			this.labelTexture(cached, values, label);
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

		const entry = { texture, nx, ny, bytes, label: undefined as string | undefined };
		this.valueTextures.set(values, entry);
		this.valueTextureBytes += bytes;
		this.labelTexture(entry, values, label);
		return texture;
	}

	private labelTexture(
		entry: { label?: string },
		values: Float32Array,
		label: string | undefined
	): void {
		if (!label || entry.label === label) return;
		entry.label = label;
		this.textureLabels.set(label, values);
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
	 * A draw binds up to ~9 textures fetched one after another in the same
	 * frame; the most recent entries must survive eviction or a batch could
	 * delete a texture it is about to bind. (targetBytes 0 = full clear.)
	 */
	private static readonly MIN_RESIDENT_TEXTURES = 12;

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
			if (entry.label && this.textureLabels.get(entry.label) === key) {
				this.textureLabels.delete(entry.label);
			}
		}
	}

	/**
	 * Rasterise (or reuse) the polygon clip mask for resolved clipping options.
	 * Returns undefined when the options carry no polygons.
	 */
	getClipMask(clipping: ResolvedClippingOptions): GpuClipMask | undefined {
		if (this.clipMasks.has(clipping)) return this.clipMasks.get(clipping);

		const gl = this.gl;
		let mask: GpuClipMask | undefined;
		const source = rasterizeClipMask(clipping);
		if (source) {
			const texture = gl.createTexture();
			if (texture) {
				gl.bindTexture(gl.TEXTURE_2D, texture);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source.canvas);
				mask = { texture, rect: source.rect };
			}
		}

		this.clipMasks.set(clipping, mask);
		while (this.clipMasks.size > WeatherGpuRenderer.CLIP_MASK_CACHE_MAX) {
			const oldest = this.clipMasks.keys().next().value!;
			const evicted = this.clipMasks.get(oldest);
			if (evicted) gl.deleteTexture(evicted.texture);
			this.clipMasks.delete(oldest);
		}
		return mask;
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
		const multiTemporal = layers.length > 1 && layers.every((layer) => layer.prevTexture);
		const advect = opts.advect !== undefined && layers.length === 1;
		const spec: FragmentShaderSpec = {
			layers: layers.map((layer, i) => layerSpecOf(layer, i === layers.length - 1)),
			interpolation: opts.interpolation,
			temporal: multiTemporal,
			contours: opts.contours !== undefined,
			clipMask: opts.clipMask !== undefined,
			advect
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
			bindTexture(layerUniformNames(i).values, layers[i].valuesTexture);
			uploadGridLayerUniforms(gl, u, i, spec.layers[i], layers[i], bindTexture);
		}

		bindTexture('u_lut', opts.lut.texture);
		if (layers.length === 1) {
			// A one-layer seamless composite carries its blend state per layer.
			const prevTexture = opts.prevTexture ?? layers[0].prevTexture;
			bindTexture('u_valuesPrev', prevTexture ?? layers[0].valuesTexture);
			gl.uniform1f(u('u_mix'), prevTexture ? (opts.mix ?? 1) : 1);
			if (advect && opts.advect) {
				bindTexture('u_windU', opts.advect.uTexture);
				bindTexture('u_windV', opts.advect.vTexture);
				gl.uniform2f(u('u_advect'), opts.advect.prevDeg, opts.advect.nextDeg);
			}
		} else if (multiTemporal) {
			for (let i = 0; i < layers.length; i++) {
				bindTexture(`u_valuesPrev${i}`, layers[i].prevTexture!);
			}
			gl.uniform1f(u('u_mix'), opts.mix ?? 1);
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

		const contours = opts.contours;
		if (contours) {
			this.contourLevelScratch.fill(0);
			this.contourLevelScratch.set(contours.levels.slice(0, 48));
			gl.uniform1fv(u('u_contourLevels'), this.contourLevelScratch);
			gl.uniform1i(u('u_contourCount'), Math.min(contours.levels.length, 48));
			gl.uniform1f(u('u_contourStep'), contours.step);
			gl.uniform1f(u('u_contourMinGap'), contours.minGap);
			gl.uniform3f(u('u_contourColor'), ...contours.color);
			gl.uniform4f(u('u_contourAlpha'), ...contours.classAlphas);
			gl.uniform4f(u('u_contourWidth'), ...contours.classWidths);
			gl.uniform3f(u('u_contourMods'), ...contours.moduli);
			gl.uniform1f(u('u_contourOpacity'), contours.opacity);
		}

		const clip = opts.clipBounds;
		if (clip) {
			gl.uniform4f(u('u_clipBounds'), clip[0], clip[1], clip[2], clip[3]);
		} else {
			gl.uniform4f(u('u_clipBounds'), -1e9, -1e9, 1e9, 1e9);
		}
		if (opts.clipMask) {
			bindTexture('u_clipMask', opts.clipMask.texture);
			gl.uniform4f(u('u_clipMaskRect'), ...opts.clipMask.rect);
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

	/**
	 * Create a per-layer arrow instance store. The renderer may be shared by
	 * several layers on one GL context, so instances (and their VAOs) belong to
	 * the layer, not the renderer.
	 */
	createArrowInstances(): ArrowInstances {
		const buffer = this.gl.createBuffer();
		if (!buffer) throw new Error('gpu: could not create arrow instance buffer');
		return { buffer, capacityBytes: 0, count: 0, vaos: new Map() };
	}

	deleteArrowInstances(instances: ArrowInstances): void {
		const gl = this.gl;
		gl.deleteBuffer(instances.buffer);
		for (const vao of instances.vaos.values()) gl.deleteVertexArray(vao);
		instances.vaos.clear();
		instances.count = 0;
	}

	/**
	 * Upload the instanced arrow states (ARROW_INSTANCE_FLOATS per arrow). The
	 * buffer persists; call once per data/viewport change, not per frame.
	 */
	setArrowInstances(instances: ArrowInstances, data: Float32Array): void {
		const gl = this.gl;
		gl.bindBuffer(gl.ARRAY_BUFFER, instances.buffer);
		if (data.byteLength > instances.capacityBytes) {
			gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
			instances.capacityBytes = data.byteLength;
		} else {
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
		}
		instances.count = data.length / ARROW_INSTANCE_FLOATS;
	}

	/** Draw an arrow instance store as a screen-space overlay pass. */
	drawArrows(opts: {
		instances: ArrowInstances;
		projection?: GpuDrawOptions['projection'];
		matrix?: ArrayLike<number>;
		/** Icon box size in pixels. */
		sizePx: number;
		/** Stroke RGB 0..1. */
		color: [number, number, number];
		opacity: number;
		/** Temporal blend factor between the instances' prev/cur states. */
		mix: number;
		/** Fractional zoom gating the anchors' visibility thresholds. */
		zoomFrac: number;
		/** Drawing buffer size in CSS pixels. */
		viewport: [number, number];
		/** Flat-mercator screen length of the shader's foreshortening probe step. */
		refStepPx: number;
		worldOffsets?: number[];
	}): void {
		const instances = opts.instances;
		if (instances.count === 0) return;
		const gl = this.gl;
		const info = this.getArrowProgram(opts.projection?.shaderData);
		const u = (name: string): WebGLUniformLocation | null => info.uniforms.get(name) ?? null;

		gl.useProgram(info.program);
		gl.bindVertexArray(this.getArrowVao(instances, opts.projection?.shaderData));

		if (opts.projection) {
			const p = opts.projection.data;
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

		gl.uniform1f(u('u_mix'), opts.mix);
		gl.uniform1f(u('u_zoomFrac'), opts.zoomFrac);
		gl.uniform1f(u('u_sizePx'), opts.sizePx);
		gl.uniform2f(u('u_viewport'), opts.viewport[0], opts.viewport[1]);
		gl.uniform1f(u('u_refStepPx'), opts.refStepPx);
		gl.uniform3f(u('u_color'), opts.color[0], opts.color[1], opts.color[2]);
		gl.uniform1f(u('u_opacity'), opts.opacity);

		for (const offset of opts.worldOffsets ?? [0]) {
			gl.uniform1f(u('u_worldOffset'), offset);
			gl.drawArraysInstanced(gl.TRIANGLES, 0, ARROW_TEMPLATE.length / 3, instances.count);
		}

		gl.bindVertexArray(null);
	}

	dispose(): void {
		const gl = this.gl;
		for (const { texture } of this.valueTextures.values()) gl.deleteTexture(texture);
		this.valueTextures.clear();
		this.textureLabels.clear();
		this.valueTextureBytes = 0;
		for (const { texture } of this.lutTextures.values()) gl.deleteTexture(texture);
		this.lutTextures.clear();
		for (const mask of this.clipMasks.values()) {
			if (mask) gl.deleteTexture(mask.texture);
		}
		this.clipMasks.clear();
		for (const { program, vao } of this.programs.values()) {
			gl.deleteProgram(program);
			gl.deleteVertexArray(vao);
		}
		this.programs.clear();
		for (const { program } of this.arrowPrograms.values()) {
			gl.deleteProgram(program);
		}
		this.arrowPrograms.clear();
		if (this.quadBuffer) {
			gl.deleteBuffer(this.quadBuffer);
			this.quadBuffer = null;
		}
		if (this.meshBuffers) {
			gl.deleteBuffer(this.meshBuffers.vertices);
			gl.deleteBuffer(this.meshBuffers.indices);
			this.meshBuffers = null;
		}
		if (this.arrowTemplateBuffer) {
			gl.deleteBuffer(this.arrowTemplateBuffer);
			this.arrowTemplateBuffer = null;
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

	private getArrowProgram(shaderData?: ProjectionShaderData): {
		program: WebGLProgram;
		uniforms: Map<string, WebGLUniformLocation>;
	} {
		const key = shaderData?.variantName ?? 'plain';
		const cached = this.arrowPrograms.get(key);
		if (cached) return cached;

		const gl = this.gl;
		const program = gl.createProgram();
		if (!program) throw new Error('gpu: could not create arrow program');
		gl.attachShader(program, this.compile(gl.VERTEX_SHADER, arrowVertexSource(shaderData)));
		gl.attachShader(program, this.compile(gl.FRAGMENT_SHADER, ARROW_FRAGMENT_SOURCE));
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			const log = gl.getProgramInfoLog(program);
			gl.deleteProgram(program);
			throw new Error(`gpu: arrow program link failed: ${log}`);
		}

		const uniforms = new Map<string, WebGLUniformLocation>();
		const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
		for (let i = 0; i < count; i++) {
			const active = gl.getActiveUniform(program, i);
			if (!active) continue;
			const location = gl.getUniformLocation(program, active.name);
			if (location) uniforms.set(active.name.replace(/\[0\]$/, ''), location);
		}

		const info = { program, uniforms };
		this.arrowPrograms.set(key, info);
		return info;
	}

	/** VAO tying a layer's instance buffer to the projection variant's program. */
	private getArrowVao(
		instances: ArrowInstances,
		shaderData?: ProjectionShaderData
	): WebGLVertexArrayObject {
		const key = shaderData?.variantName ?? 'plain';
		const cached = instances.vaos.get(key);
		if (cached) return cached;

		const gl = this.gl;
		const { program } = this.getArrowProgram(shaderData);
		if (!this.arrowTemplateBuffer) {
			const buffer = gl.createBuffer();
			if (!buffer) throw new Error('gpu: could not create arrow template buffer');
			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
			gl.bufferData(gl.ARRAY_BUFFER, ARROW_TEMPLATE, gl.STATIC_DRAW);
			this.arrowTemplateBuffer = buffer;
		}

		const vao = gl.createVertexArray();
		if (!vao) throw new Error('gpu: could not create arrow VAO');
		gl.bindVertexArray(vao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.arrowTemplateBuffer);
		const aTemplate = gl.getAttribLocation(program, 'a_template');
		gl.enableVertexAttribArray(aTemplate);
		gl.vertexAttribPointer(aTemplate, 3, gl.FLOAT, false, 0, 0);

		// Per-instance state: anchor + previous/current samples + alphas.
		gl.bindBuffer(gl.ARRAY_BUFFER, instances.buffer);
		const stride = ARROW_INSTANCE_FLOATS * 4;
		const instanceAttribute = (name: string, size: number, offsetFloats: number): void => {
			const location = gl.getAttribLocation(program, name);
			if (location < 0) return;
			gl.enableVertexAttribArray(location);
			gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offsetFloats * 4);
			gl.vertexAttribDivisor(location, 1);
		};
		instanceAttribute('a_anchor', 2, 0);
		instanceAttribute('a_prev', 4, 2);
		instanceAttribute('a_cur', 4, 6);
		instanceAttribute('a_alpha', 2, 10);
		instanceAttribute('a_threshold', 1, 12);
		gl.bindVertexArray(null);

		instances.vaos.set(key, vao);
		return vao;
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
