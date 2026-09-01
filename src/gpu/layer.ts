/**
 * Path B: a MapLibre custom layer that renders the weather field directly in
 * the map's WebGL2 context — no tiles, no worker round-trips, no bitmaps.
 *
 * The grid values live in float textures; every frame a fragment shader maps
 * each screen pixel (mercator -> lat/lon -> grid projection -> interpolation
 * -> colour LUT). Consequences:
 *
 * - restyling (colour scale, interpolation, opacity) is just a uniform/LUT
 *   change followed by a repaint — nothing is re-rendered tile by tile;
 * - a timestep change swaps a texture and can blend the *data values* of the
 *   two timesteps in-shader (true temporal interpolation, not an alpha fade);
 * - zooming/panning never shows resampled stale tiles;
 * - a seamless composite renders as one multi-layer pass, blending sub-domains
 *   per pixel with the same smooth-step edge weights as the CPU worker;
 * - wind arrows (`setArrows`) draw as an instanced overlay pass in the same
 *   layer, sampled on the CPU with the exact tile-worker samplers and morphed
 *   in-shader together with the raster blend.
 *
 * Data loading reuses the om protocol's URL grammar and state cache, so the
 * layer accepts the same om:// URLs as the CPU raster path. Call `setUrl`
 * again (same URL is fine) after significant viewport changes so viewport-
 * cropped data and seamless viewport gates can follow the map.
 *
 * `prepareUrl` splits the load from the visual swap: it resolves to a commit
 * callback once the data is ready, so a host showing several layers can load
 * them all first and commit them in the same frame (synchronised animation).
 * `setUrl` is prepare + immediate commit.
 */
import { isSeamlessDomain } from '../domain-helpers';
import { GridFactory } from '../grids/index';
import { defaultOmProtocolSettings } from '../om-protocol';
import { halfQuantum as computeHalfQuantum, lat2tile } from '../utils/math';
import { parseRequest } from '../utils/parse-request';
import { normalizeUrl, parseUrlComponents } from '../utils/parse-url';
import { sampleBlendedVector } from '../utils/seamless-sampling';
import type {
	CustomLayerInterface,
	CustomRenderMethodInput,
	Map as MapLibreMap
} from 'maplibre-gl';

import { buildArrowAnchors, buildArrowInstances } from './arrows';
import type { ArrowSampler, GpuArrowConfig } from './arrows';
import { loadOmUrl } from './data';
import { computeGridUniforms } from './grid-uniforms';
import type { GpuGridUniforms } from './grid-uniforms';
import { WeatherGpuRenderer } from './renderer';
import type {
	ArrowInstances,
	GpuContourDraw,
	GpuContourStyle,
	GpuDrawOptions,
	GpuLayerDraw
} from './renderer';
import { activeSeamlessLayers, loadSeamlessLayer } from './seamless-data';
import type { GpuSeamlessLayerData } from './seamless-data';

import type {
	Bounds,
	InterpolationMethod,
	OmProtocolSettings,
	ParsedRequest,
	RenderableColorScale,
	SeamlessDomain,
	SeamlessLayer,
	SeamlessLayerRenderData
} from '../types';

export interface WeatherGpuLayerOptions {
	id?: string;
	settings?: OmProtocolSettings;
	/** Layer opacity 0..1. @default 1 */
	opacity?: number;
	/**
	 * Duration of the in-shader temporal value blend when the URL changes to a
	 * new timestep on the same grid. 0 disables blending. @default 250
	 */
	fadeMs?: number;
	/** Draw the colour-mapped raster field. Disable for an arrows-only layer. @default true */
	drawRaster?: boolean;
	/**
	 * Byte budget (in MB) for cached value textures in VRAM. More budget keeps
	 * more timesteps resident, so animation loops replay without re-uploads.
	 * @default 256
	 */
	textureCacheMb?: number;
}

interface RenderStyle {
	interpolation: InterpolationMethod;
	colorScale: RenderableColorScale;
	colorBlend: boolean;
	clipBounds?: Bounds;
}

interface PlainFrame extends RenderStyle {
	values: Float32Array;
	gridUniforms: GpuGridUniforms;
	/** Identity of the grid geometry; temporal blending requires equal signatures. */
	gridSignature: string;
	halfQuantum: number;
	/** Wind sampler for the arrow pass; only set when the data has directions. */
	sampler?: ArrowSampler;
	/** URL-state key, labelling the texture for residency queries. */
	stateKey: string;
	/** Contour levels of the request (a single entry means a step interval). */
	intervals: number[];
}

interface SeamlessEntry {
	status: 'loading' | 'loaded' | 'skipped';
	data?: GpuSeamlessLayerData;
}

interface SeamlessFrame extends RenderStyle {
	domain: SeamlessDomain;
	request: ParsedRequest;
	/** Per sub-domain load state, keyed by the layer's domainValue. */
	entries: Map<string, SeamlessEntry>;
	/** Blended wind sampler over the currently drawn sub-layers. */
	sampler?: ArrowSampler;
	samplerKey?: string;
	/** Contour levels of the request (a single entry means a step interval). */
	intervals: number[];
}

/**
 * One renderer per GL context, shared by every WeatherGpuLayer on the map:
 * programs, LUTs and value textures dedupe across layers (a raster slot and an
 * arrow slot of the same source reuse one texture), and the VRAM budget is a
 * single global figure instead of one per layer.
 */
const sharedRenderers = new Map<
	WebGL2RenderingContext,
	{ renderer: WeatherGpuRenderer; refs: number }
>();

const acquireSharedRenderer = (
	gl: WebGL2RenderingContext,
	textureCacheMb?: number
): WeatherGpuRenderer => {
	let entry = sharedRenderers.get(gl);
	if (!entry) {
		entry = { renderer: new WeatherGpuRenderer(gl, { textureCacheMb }), refs: 0 };
		sharedRenderers.set(gl, entry);
	} else if (textureCacheMb !== undefined) {
		entry.renderer.setTextureBudget(textureCacheMb);
	}
	entry.refs++;
	return entry.renderer;
};

const releaseSharedRenderer = (gl: WebGL2RenderingContext): void => {
	const entry = sharedRenderers.get(gl);
	if (!entry) return;
	entry.refs--;
	if (entry.refs <= 0) {
		entry.renderer.dispose();
		sharedRenderers.delete(gl);
	}
};

export class WeatherGpuLayer implements CustomLayerInterface {
	id: string;
	type = 'custom' as const;
	renderingMode = '2d' as const;

	private settings: OmProtocolSettings;
	private opacity: number;
	private fadeMs: number;
	private drawRaster: boolean;
	private textureCacheMb: number | undefined;

	private map: MapLibreMap | undefined;
	private renderer: WeatherGpuRenderer | undefined;
	private rendererGl: WebGL2RenderingContext | undefined;
	private arrowInstances: ArrowInstances | undefined;

	private current: PlainFrame | undefined;
	private previous: Pick<PlainFrame, 'values' | 'gridUniforms'> | undefined;
	private fadeStart = 0;

	private seamless: SeamlessFrame | undefined;
	/**
	 * Replacement seamless frame still loading. The old frame keeps rendering
	 * until the new one has all zoom-active sub-layers resolved, then they swap
	 * atomically — otherwise every refresh would flash global-only (or nothing)
	 * while the finer layers reload.
	 */
	private pendingSeamless: SeamlessFrame | undefined;
	/**
	 * Previous-timestep values per sub-domain: when a seamless commit replaces a
	 * compatible composite (same domain/variable/grids), both composites blend
	 * temporally in-shader like the single-layer path.
	 */
	private seamlessPrev: Map<string, { values: Float32Array; nx: number; ny: number }> | undefined;
	/**
	 * The replaced visual when a commit cannot value-morph (variable or domain
	 * switch): it keeps rendering underneath while the new one dissolves in on
	 * top, with the FrameManager's opacity compensation so the combined
	 * coverage never dips or over-darkens.
	 */
	private outgoing: { plain?: PlainFrame; seamless?: SeamlessFrame } | undefined;
	private crossfadeStart = 0;

	private arrows: GpuArrowConfig | undefined;
	private contours: GpuContourStyle | undefined;
	/** Sampler of the outgoing frame, for rebuilding instances mid-blend. */
	private arrowPrevSampler: ArrowSampler | undefined;
	/** Bumped whenever the arrow data changes; part of the instance identity. */
	private arrowGeneration = 0;
	private arrowInstanceKey = '';

	/** Guards against out-of-order setUrl loads; only the latest wins. */
	private loadSequence = 0;

	constructor(options: WeatherGpuLayerOptions = {}) {
		this.id = options.id ?? 'weather-gpu-layer';
		this.settings = options.settings ?? defaultOmProtocolSettings;
		this.opacity = options.opacity ?? 1;
		this.fadeMs = options.fadeMs ?? 250;
		this.drawRaster = options.drawRaster ?? true;
		this.textureCacheMb = options.textureCacheMb;
	}

	/** VRAM used/budgeted by this layer's cached value textures. */
	getMemoryUsage(): { bytes: number; budgetBytes: number; textures: number } {
		return this.renderer?.getMemoryUsage() ?? { bytes: 0, budgetBytes: 0, textures: 0 };
	}

	/** True when a texture for this value array is resident in VRAM. */
	hasValueTexture(values: Float32Array): boolean {
		return this.renderer?.hasValueTexture(values) ?? false;
	}

	/**
	 * True when a texture for this URL's data is resident in VRAM — texture
	 * labels outlive the (much smaller) decoded-RAM state cache.
	 */
	hasTextureForUrl(omUrl: string): boolean {
		if (!this.renderer) return false;
		try {
			const url = omUrl.startsWith('om://') ? omUrl : 'om://' + omUrl;
			return this.renderer.hasTextureForLabel(parseUrlComponents(url).fileAndVariableKey);
		} catch {
			return false;
		}
	}

	/**
	 * Change the temporal blend duration at runtime — an animation loop sets it
	 * to its frame interval so consecutive timesteps morph back to back.
	 */
	setFadeMs(fadeMs: number): void {
		this.fadeMs = fadeMs;
	}

	/**
	 * Points the layer at an om:// URL (meta-JSON forms like latest.json are
	 * resolved exactly like the tile protocol does). Seamless composite domains
	 * are supported: their sub-layers load lazily per zoom level. Resolves once
	 * the data is loaded and shown; the next frame will draw it.
	 */
	async setUrl(omUrl: string, signal?: AbortSignal): Promise<void> {
		const commit = await this.prepareUrl(omUrl, signal);
		commit?.();
	}

	/**
	 * Loads the URL without showing it. Resolves to a commit callback that
	 * performs the visual swap (or null when a newer load superseded this one).
	 * Committing is cheap and synchronous, so several layers can be prepared
	 * concurrently and committed in the same frame.
	 */
	async prepareUrl(omUrl: string, signal?: AbortSignal): Promise<(() => void) | null> {
		const sequence = ++this.loadSequence;

		const url = await normalizeUrl(omUrl, this.settings.domainOptions);
		const request = parseRequest(url, this.settings);
		if (sequence !== this.loadSequence) return null; // superseded by a newer setUrl

		if (isSeamlessDomain(request.dataOptions.domain)) {
			const renderOptions = request.renderOptions;
			const frame: SeamlessFrame = {
				domain: request.dataOptions.domain,
				request,
				entries: new Map(),
				interpolation: renderOptions.interpolation,
				colorScale: renderOptions.colorScale,
				colorBlend: renderOptions.colorBlend,
				clipBounds: request.clippingOptions?.bounds,
				intervals: renderOptions.intervals
			};
			if (this.seamless || this.current) {
				// Something is already on screen: load the new frame behind it and
				// swap only once every zoom-active sub-layer has resolved.
				this.pendingSeamless = frame;
			} else {
				// Nothing showing yet: render progressively as sub-layers arrive.
				this.seamless = frame;
			}
			// Load the layers active at the current zoom right away; render() keeps
			// them in sync when the zoom changes later.
			await this.ensureSeamlessLoads(frame, this.map?.getZoom() ?? 0);
			if (sequence !== this.loadSequence) return null;
			return () => {
				if (sequence !== this.loadSequence) return;
				const old = this.seamless;
				this.seamlessPrev = this.seamlessPrevOf(old, frame);
				this.arrowPrevSampler = this.seamlessPrev ? old?.sampler : undefined;
				if (this.seamlessPrev) {
					this.fadeStart = performance.now();
				} else {
					this.beginCrossfade();
				}
				this.current = undefined;
				this.previous = undefined;
				this.seamless = frame;
				if (this.pendingSeamless === frame) this.pendingSeamless = undefined;
				this.arrowGeneration++;
				this.map?.triggerRepaint();
			};
		}

		const loaded = await loadOmUrl(omUrl, this.settings, signal);
		if (sequence !== this.loadSequence) return null;

		const values = loaded.data.values;
		if (!values) {
			throw new Error('gpu: URL resolved to data without scalar values');
		}

		const gridUniforms = computeGridUniforms(loaded.domain.grid, loaded.ranges);
		// Temporal blending mixes raw data values, so it is only meaningful across
		// timesteps of the *same* variable on the same grid — a variable or domain
		// switch must swap instantly, not morph temperatures into cloud cover.
		const gridSignature = JSON.stringify({
			...gridUniforms,
			quad: undefined,
			variable: loaded.request.dataOptions.variable,
			domain: loaded.domain.value
		});
		const renderOptions = loaded.request.renderOptions;

		// The same per-point sampling the tile worker uses: magnitude with the
		// selected method, direction blended circularly.
		const directions = loaded.data.directions;
		let sampler: ArrowSampler | undefined;
		if (directions) {
			const grid = GridFactory.create(loaded.domain.grid, loaded.ranges);
			const interpolation = renderOptions.interpolation;
			sampler = (lat, lon) => ({
				value: grid.getInterpolatedValue(values, lat, lon, interpolation),
				direction: grid.getLinearInterpolatedDirection(directions, lat, lon)
			});
		}

		const frame: PlainFrame = {
			values,
			gridUniforms,
			gridSignature,
			interpolation: renderOptions.interpolation,
			colorScale: renderOptions.colorScale,
			colorBlend: renderOptions.colorBlend,
			halfQuantum: computeHalfQuantum(loaded.data.scaleFactor),
			clipBounds: loaded.request.clippingOptions?.bounds,
			sampler,
			stateKey: loaded.request.fileAndVariableKey,
			intervals: renderOptions.intervals
		};

		// Warm the value texture so the commit itself never uploads mid-frame.
		this.renderer?.getValueTexture(values, gridUniforms.nx, gridUniforms.ny, frame.stateKey);

		return () => {
			if (sequence !== this.loadSequence) return;
			// Same variable + grid geometry -> blend the data values of old and new
			// frame in the shader. Anything else swaps instantly.
			if (this.current && this.fadeMs > 0 && this.current.gridSignature === frame.gridSignature) {
				this.previous = {
					values: this.current.values,
					gridUniforms: this.current.gridUniforms
				};
				this.arrowPrevSampler = this.current.sampler;
				this.fadeStart = performance.now();
			} else {
				this.previous = undefined;
				this.arrowPrevSampler = undefined;
				this.beginCrossfade();
			}

			this.seamless = undefined;
			this.pendingSeamless = undefined;
			this.current = frame;
			this.arrowGeneration++;
			this.map?.triggerRepaint();
		};
	}

	/** Keep the visual being replaced for a dissolve (variable/domain switch). */
	private beginCrossfade(): void {
		if (this.fadeMs <= 0 || (!this.current && !this.seamless)) return;
		this.outgoing = { plain: this.current, seamless: this.seamless };
		this.crossfadeStart = performance.now();
	}

	setOpacity(opacity: number): void {
		this.opacity = opacity;
		this.map?.triggerRepaint();
	}

	/** Configure (or remove) the instanced wind-arrow overlay pass. */
	setArrows(config: GpuArrowConfig | undefined): void {
		this.arrows = config;
		this.arrowGeneration++;
		this.map?.triggerRepaint();
	}

	/**
	 * Configure (or remove) the in-shader contour isolines. The levels come
	 * from the URL's render options (like the CPU tile contours); this sets the
	 * line styling. With `drawRaster: false` the layer draws lines only.
	 */
	setContours(style: GpuContourStyle | undefined): void {
		this.contours = style;
		this.map?.triggerRepaint();
	}

	/**
	 * Longitudinal cell size in degrees — the resolution the isolines can
	 * trust. Below ~2px per cell the bilinear derivative jitters per pixel and
	 * the lines speckle, so they fade out with the resolution.
	 */
	private static cellSizeDeg(g: GpuGridUniforms): number {
		if (g.gridKind === 'gaussian') return 360 / (4 * g.gauss[0] + 16);
		if (g.gridKind === 'projected') return g.dx / 111_000;
		return g.dx;
	}

	/** The draw-ready contour pass for a frame's levels, if configured. */
	private contourDrawOf(
		intervals: number[],
		opacity: number,
		gridUniforms: GpuGridUniforms
	): GpuContourDraw | undefined {
		const style = this.contours;
		if (!style || intervals.length === 0) return undefined;

		// The bilinear derivative only settles once a grid cell spans several
		// screen pixels; below that isolines crumble into speckle.
		const cellPx =
			(WeatherGpuLayer.cellSizeDeg(gridUniforms) / 360) *
			512 *
			Math.pow(2, this.map?.getZoom() ?? 0);
		const t = Math.min(1, Math.max(0, (cellPx - 3) / 2));
		const resolutionFade = t * t * (3 - 2 * t);
		if (resolutionFade <= 0) return undefined;
		opacity *= resolutionFade;

		// Style widths are CSS pixels; the shader works in device pixels.
		const ratio = this.map?.getPixelRatio() ?? 1;
		const classWidths = style.classWidths.map((width) => width * ratio) as [
			number,
			number,
			number,
			number
		];
		if (intervals.length === 1) {
			return {
				...style,
				classWidths,
				step: intervals[0],
				levels: [],
				minGap: intervals[0],
				opacity
			};
		}
		const levels = [...intervals].sort((a, b) => a - b).slice(0, 48);
		let minGap = Infinity;
		for (let i = 1; i < levels.length; i++) {
			minGap = Math.min(minGap, levels[i] - levels[i - 1]);
		}
		return {
			...style,
			classWidths,
			step: 0,
			levels,
			minGap: isFinite(minGap) ? minGap : 1,
			opacity
		};
	}

	onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
		if (!(gl instanceof WebGL2RenderingContext)) {
			throw new Error('gpu: WeatherGpuLayer requires a WebGL2 map context');
		}
		this.map = map;
		this.rendererGl = gl;
		this.renderer = acquireSharedRenderer(gl, this.textureCacheMb);
	}

	onRemove(): void {
		if (this.renderer && this.arrowInstances) {
			this.renderer.deleteArrowInstances(this.arrowInstances);
			this.arrowInstances = undefined;
		}
		if (this.rendererGl) {
			releaseSharedRenderer(this.rendererGl);
			this.rendererGl = undefined;
		}
		this.renderer = undefined;
		this.map = undefined;
	}

	render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
		if (!this.renderer || !this.map) return;
		const gl2 = gl as WebGL2RenderingContext;

		// The map's own projectTile prelude renders mercator, globe and the
		// transition between them; the fragment shader is projection-agnostic.
		const projection: GpuDrawOptions['projection'] = {
			shaderData: args.shaderData,
			data: args.defaultProjectionData
		};

		// A variable/domain switch dissolves: the outgoing visual renders
		// underneath on the compensation curve b = p(1-e)/(1-p·e) while the new
		// one fades in on top, so the combined coverage stays at p throughout.
		let opacity = this.opacity;
		if (this.outgoing) {
			const t = Math.min(1, (performance.now() - this.crossfadeStart) / this.fadeMs);
			if (t >= 1) {
				this.outgoing = undefined;
			} else {
				const e = t * t * (3 - 2 * t);
				const p = this.opacity;
				const under = (p * (1 - e)) / Math.max(0.001, 1 - p * e);
				const out = this.outgoing;
				if (out.seamless) {
					this.renderSeamless(gl2, projection, out.seamless, under, true);
				} else if (out.plain) {
					this.renderPlain(gl2, projection, out.plain, under, true);
				}
				opacity = p * e;
				this.map.triggerRepaint();
			}
		}

		if (this.seamless) {
			this.renderSeamless(gl2, projection, this.seamless, opacity, false);
		} else if (this.current) {
			this.renderPlain(gl2, projection, this.current, opacity, false);
		}
	}

	private renderPlain(
		gl: WebGL2RenderingContext,
		projection: GpuDrawOptions['projection'],
		frame: PlainFrame,
		opacity: number,
		/** Outgoing crossfade visual: static, no blend state, no arrows. */
		still: boolean
	): void {
		const renderer = this.renderer!;

		let mix = 1;
		let prevTexture: WebGLTexture | undefined;
		if (!still && this.previous) {
			mix = Math.min(1, (performance.now() - this.fadeStart) / this.fadeMs);
			if (mix < 1) {
				const prev = this.previous.gridUniforms;
				prevTexture = renderer.getValueTexture(this.previous.values, prev.nx, prev.ny);
				this.map!.triggerRepaint(); // keep animating the blend
			} else {
				this.previous = undefined;
				this.arrowPrevSampler = undefined;
			}
		}

		const contours = this.contourDrawOf(frame.intervals, opacity, frame.gridUniforms);
		if (this.drawRaster || contours) {
			const g = frame.gridUniforms;
			renderer.draw({
				projection,
				layers: [
					{
						gridUniforms: g,
						valuesTexture: renderer.getValueTexture(frame.values, g.nx, g.ny, frame.stateKey)
					}
				],
				interpolation: frame.interpolation,
				prevTexture,
				mix,
				lut: renderer.getLut(frame.colorScale, frame.colorBlend),
				halfQuantum: frame.halfQuantum,
				opacity: this.drawRaster ? opacity : 0,
				clipBounds: frame.clipBounds,
				worldOffsets: this.worldOffsets(projection),
				contours
			});
		}

		if (!still) {
			this.drawArrowPass(gl, projection, frame.sampler, mix, opacity, frame.clipBounds);
		}
	}

	private renderSeamless(
		gl: WebGL2RenderingContext,
		projection: GpuDrawOptions['projection'],
		frame: SeamlessFrame,
		opacity: number,
		/** Outgoing crossfade visual: static, no blend state, no loads, no arrows. */
		still: boolean
	): void {
		const renderer = this.renderer!;
		const zoom = this.map!.getZoom();

		// Keep loads in sync with the zoom level: entering a finer layer's range
		// kicks its load; the frame renders with whatever is loaded meanwhile.
		if (!still) void this.ensureSeamlessLoads(frame, zoom);

		let mix = 1;
		if (!still && this.seamlessPrev) {
			mix = Math.min(1, (performance.now() - this.fadeStart) / this.fadeMs);
			if (mix < 1) {
				this.map!.triggerRepaint(); // keep animating the blend
			} else {
				this.seamlessPrev = undefined;
				this.arrowPrevSampler = undefined;
			}
		}

		const active = activeSeamlessLayers(frame.domain, zoom);
		const drawLayers: GpuLayerDraw[] = [];
		const drawnData: GpuSeamlessLayerData[] = [];
		let finestScaleFactor: number | undefined;
		for (const layerDef of active) {
			const entry = frame.entries.get(layerDef.domainValue);
			if (entry?.status !== 'loaded' || !entry.data) continue;
			const data = entry.data;
			const g = data.gridUniforms;
			const prev = mix < 1 ? this.seamlessPrev?.get(layerDef.domainValue) : undefined;
			drawLayers.push({
				gridUniforms: g,
				valuesTexture: renderer.getValueTexture(data.values, g.nx, g.ny, data.stateKey),
				blendWidthDeg: data.blendWidthDeg,
				nanTexture: data.nanField ? renderer.getValueTexture(data.nanField, g.nx, g.ny) : undefined,
				prevTexture: prev ? renderer.getValueTexture(prev.values, prev.nx, prev.ny) : undefined
			});
			drawnData.push(data);
			finestScaleFactor ??= data.scaleFactor;
		}
		if (drawLayers.length === 0) return;

		// All-or-nothing: a sub-layer without a previous state (e.g. loaded after
		// the commit) disables the temporal blend for the whole composite.
		if (!drawLayers.every((layer) => layer.prevTexture !== undefined)) {
			for (const layer of drawLayers) layer.prevTexture = undefined;
			mix = 1;
		}

		const contours = this.contourDrawOf(frame.intervals, opacity, drawLayers[0].gridUniforms);
		if (this.drawRaster || contours) {
			renderer.draw({
				projection,
				layers: drawLayers,
				interpolation: frame.interpolation,
				mix,
				lut: renderer.getLut(frame.colorScale, frame.colorBlend),
				// Same convention as the CPU worker: the primary (finest) layer's
				// quantisation step drives the colour threshold offset.
				halfQuantum: computeHalfQuantum(finestScaleFactor),
				opacity: this.drawRaster ? opacity : 0,
				clipBounds: frame.clipBounds,
				worldOffsets: this.worldOffsets(projection),
				contours
			});
		}

		if (!still && this.arrows) {
			this.updateSeamlessSampler(frame, drawnData);
			this.drawArrowPass(gl, projection, frame.sampler, mix, opacity, frame.clipBounds);
		}
	}

	/**
	 * Previous-timestep values per sub-domain when two composites can blend:
	 * same seamless domain, same variable, and every loaded sub-layer of the
	 * new frame has an old counterpart on identical grid geometry.
	 */
	private seamlessPrevOf(
		old: SeamlessFrame | undefined,
		next: SeamlessFrame
	): Map<string, { values: Float32Array; nx: number; ny: number }> | undefined {
		if (!old || this.fadeMs <= 0) return undefined;
		if (old.domain.value !== next.domain.value) return undefined;
		if (old.request.dataOptions.variable !== next.request.dataOptions.variable) return undefined;

		const uniformsKey = (g: GpuGridUniforms): string => JSON.stringify({ ...g, quad: undefined });
		const prev = new Map<string, { values: Float32Array; nx: number; ny: number }>();
		for (const [domainValue, entry] of next.entries) {
			if (entry.status !== 'loaded' || !entry.data) continue;
			const oldEntry = old.entries.get(domainValue);
			if (oldEntry?.status !== 'loaded' || !oldEntry.data) return undefined;
			const g = oldEntry.data.gridUniforms;
			if (uniformsKey(entry.data.gridUniforms) !== uniformsKey(g)) return undefined;
			prev.set(domainValue, { values: oldEntry.data.values, nx: g.nx, ny: g.ny });
		}
		return prev.size > 0 ? prev : undefined;
	}

	/** Rebuild the blended wind sampler when the drawn sub-layer set changes. */
	private updateSeamlessSampler(frame: SeamlessFrame, drawn: GpuSeamlessLayerData[]): void {
		const key = drawn.map((data) => data.domain.value).join('|');
		if (frame.samplerKey === key) return;
		frame.samplerKey = key;
		this.arrowGeneration++;

		if (drawn.length === 0 || !drawn.some((data) => data.data.directions)) {
			frame.sampler = undefined;
			return;
		}
		// The exact structures the tile worker feeds sampleBlendedVector, so
		// arrows blend across sub-domain edges identically to the CPU path.
		const renderData: SeamlessLayerRenderData[] = drawn.map((data) => ({
			domain: data.domain,
			data: data.data,
			ranges: data.ranges,
			domainBounds: data.domainBounds,
			blendWidthDeg: data.blendWidthDeg
		}));
		const layerGrids = renderData.map((l) => GridFactory.create(l.domain.grid, l.ranges));
		const fullGrids = renderData.map((l) => GridFactory.create(l.domain.grid, null));
		frame.sampler = sampleBlendedVector(layerGrids, renderData, fullGrids, frame.interpolation);
	}

	/**
	 * The instanced arrow overlay. Anchors live on a screen-space lattice; the
	 * instance buffer is resampled only when the lattice, the data or the
	 * outgoing blend state changes — the per-frame cost is one instanced draw.
	 */
	private drawArrowPass(
		gl: WebGL2RenderingContext,
		projection: GpuDrawOptions['projection'],
		sampler: ArrowSampler | undefined,
		mix: number,
		opacity: number,
		clipBounds?: Bounds
	): void {
		const config = this.arrows;
		if (!config || !sampler) return;
		const renderer = this.renderer!;
		const map = this.map!;

		// Zoom gate with a one-level fade-in (and half-level fade-out above).
		const zoom = map.getZoom();
		const minZoom = config.minZoom ?? 0;
		const maxZoom = config.maxZoom ?? 24;
		const zoomFade =
			Math.min(1, Math.max(0, zoom - (minZoom - 1))) *
			Math.min(1, Math.max(0, maxZoom + 0.5 - zoom));
		if (zoomFade <= 0) return;
		opacity *= zoomFade;

		const bounds = map.getBounds();
		const view = {
			minX: (bounds.getWest() + 180) / 360,
			maxX: (bounds.getEast() + 180) / 360,
			minY: lat2tile(Math.min(85.051129, bounds.getNorth()), 0),
			maxY: lat2tile(Math.max(-85.051129, bounds.getSouth()), 0)
		};
		const anchors = buildArrowAnchors(view, map.getZoom(), config.spacingPx, clipBounds);
		const instanceKey = `${anchors.key}#${this.arrowGeneration}#${mix < 1 ? 'blend' : 'still'}`;
		this.arrowInstances ??= renderer.createArrowInstances();
		if (instanceKey !== this.arrowInstanceKey) {
			this.arrowInstanceKey = instanceKey;
			renderer.setArrowInstances(
				this.arrowInstances,
				buildArrowInstances(anchors, sampler, this.arrowPrevSampler, config.levels)
			);
		}

		const pixelRatio = map.getPixelRatio();
		renderer.drawArrows({
			instances: this.arrowInstances,
			projection,
			sizePx: config.sizePx,
			color: config.color,
			opacity,
			mix,
			viewport: [gl.drawingBufferWidth / pixelRatio, gl.drawingBufferHeight / pixelRatio],
			// The shader probes a 0.0005 mercator-y step; on flat mercator that
			// spans this many screen pixels (512px world tiles at fractional zoom).
			refStepPx: 0.0005 * 512 * Math.pow(2, map.getZoom()),
			worldOffsets: this.worldOffsets(projection)
		});
	}

	/** Kick loads for all zoom-active sub-layers that have no entry yet. */
	private async ensureSeamlessLoads(frame: SeamlessFrame, zoom: number): Promise<void> {
		const active = activeSeamlessLayers(frame.domain, zoom);
		const globalLayer = frame.domain.layers[frame.domain.layers.length - 1];
		const loads: Promise<void>[] = [];
		for (const layerDef of active) {
			if (frame.entries.has(layerDef.domainValue)) continue;
			frame.entries.set(layerDef.domainValue, { status: 'loading' });
			loads.push(this.loadSeamlessEntry(frame, layerDef, layerDef === globalLayer, active.length));
		}
		await Promise.all(loads);
	}

	private async loadSeamlessEntry(
		frame: SeamlessFrame,
		layerDef: SeamlessLayer,
		isGlobal: boolean,
		activeLayerCount: number
	): Promise<void> {
		const data = await loadSeamlessLayer(
			frame.request,
			frame.domain,
			layerDef,
			isGlobal,
			this.settings,
			activeLayerCount
		);
		// superseded by a newer setUrl
		if (this.seamless !== frame && this.pendingSeamless !== frame) return;
		frame.entries.set(
			layerDef.domainValue,
			data ? { status: 'loaded', data } : { status: 'skipped' }
		);
		this.map?.triggerRepaint();
	}

	/** World copies needed to cover the viewport across the antimeridian. */
	private worldOffsets(projection: GpuDrawOptions['projection']): number[] {
		// On the globe (and during the transition) x wraps around the sphere, so a
		// world copy would draw over the base world and double the blended alpha.
		if (projection && projection.data.projectionTransition > 0) return [0];
		if (!this.map) return [0];
		const bounds = this.map.getBounds();
		const first = Math.floor((bounds.getWest() + 180) / 360);
		const last = Math.floor((bounds.getEast() + 180) / 360);
		const offsets: number[] = [];
		for (let world = first; world <= last; world++) {
			offsets.push(world);
		}
		return offsets.length > 0 ? offsets : [0];
	}
}
