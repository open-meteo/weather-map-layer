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
import { createClippingTester } from '../utils/clipping';
import type { ResolvedClippingOptions } from '../utils/clipping';
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
import { downsampleRegular } from './downsample';
import { computeGridUniforms } from './grid-uniforms';
import type { GpuGridUniforms } from './grid-uniforms';
import { ParticleSystem, windComponentsOf } from './particles';
import type { GpuParticleConfig, ParticleFieldLayer } from './particles';
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
	GridData,
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
	/** Resolved clipping of the request; polygons render via the GPU clip mask. */
	clipping?: ResolvedClippingOptions;
	/** Lazily built polygon tester for the arrow anchors (null = none needed). */
	clipTester?: ((lon: number, lat: number) => boolean) | null;
}

interface PlainFrame extends RenderStyle {
	values: Float32Array;
	/** Wind directions of the data, for the particle pass's u/v derivation. */
	directions?: Float32Array;
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
	/** Normalized om:// URL of this frame, for re-resolving on a new crop. */
	url: string;
	/** Full-grid origin of regular grids, anchoring the downsampled contours. */
	fullOrigin?: [number, number];
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
	private particles: GpuParticleConfig | undefined;
	private particleSystem: ParticleSystem | undefined;
	/** Last particle-update timestamp; 0 restarts the step clock. */
	private particleLastTime = 0;
	/** Previous-timestep wind of a blendable commit, for the particle morph. */
	private particlePrev: { values: Float32Array; directions: Float32Array } | undefined;
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
	 * Replace the protocol settings (colour scales, clipping, …) at runtime.
	 * Hosts keep these in a store the CPU protocol reads live per request; the
	 * GPU layer must follow the same object or it parses against stale options.
	 * Takes effect on the next prepareUrl/setUrl.
	 */
	setSettings(settings: OmProtocolSettings): void {
		this.settings = settings;
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
				clipping: request.clippingOptions,
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
				if (old && this.sameSeamlessData(old, frame)) {
					// Same data re-committed (e.g. a viewport refresh after moveend):
					// keep the in-flight blend state instead of snapping the morph.
					this.seamless = frame;
					if (this.pendingSeamless === frame) this.pendingSeamless = undefined;
					this.map?.triggerRepaint();
					return;
				}
				// A commit landing mid-blend continues from the values on screen.
				const snapshot = this.seamlessBlendSnapshot(old);
				this.seamlessPrev = this.seamlessPrevOf(old, frame, snapshot);
				this.arrowPrevSampler = this.seamlessPrev ? old?.sampler : undefined;
				this.particlePrev = undefined; // seamless particles sample the target field
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
		const gridSignature = WeatherGpuLayer.frameSignature(
			gridUniforms,
			loaded.request.dataOptions.variable,
			loaded.domain.value
		);
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
			directions,
			gridUniforms,
			gridSignature,
			interpolation: renderOptions.interpolation,
			colorScale: renderOptions.colorScale,
			colorBlend: renderOptions.colorBlend,
			halfQuantum: computeHalfQuantum(loaded.data.scaleFactor),
			clipBounds: loaded.request.clippingOptions?.bounds,
			clipping: loaded.request.clippingOptions,
			sampler,
			stateKey: loaded.request.fileAndVariableKey,
			intervals: renderOptions.intervals,
			url,
			fullOrigin: WeatherGpuLayer.fullOriginOf(loaded.domain.grid, gridUniforms)
		};

		// Warm the value texture so the commit itself never uploads mid-frame.
		this.renderer?.getValueTexture(values, gridUniforms.nx, gridUniforms.ny, frame.stateKey);

		// A viewport-crop change cannot blend against the shown frame directly:
		// it lives on different grid geometry. Re-resolve the shown URL — the
		// protocol crops against the *current* viewport, mostly from cache — so
		// the commit can morph values on the new geometry instead of dissolving.
		let recropped: Float32Array | undefined;
		const shown = this.current;
		if (shown && this.fadeMs > 0 && shown.gridSignature !== frame.gridSignature) {
			try {
				const prev = await loadOmUrl(shown.url, this.settings, signal);
				if (sequence !== this.loadSequence) return null;
				const prevUniforms = computeGridUniforms(prev.domain.grid, prev.ranges);
				const prevSignature = WeatherGpuLayer.frameSignature(
					prevUniforms,
					prev.request.dataOptions.variable,
					prev.domain.value
				);
				if (prevSignature === frame.gridSignature && prev.data.values) {
					recropped = prev.data.values;
					this.renderer?.getValueTexture(recropped, prevUniforms.nx, prevUniforms.ny);
				}
			} catch {
				// Fall back to the dissolve.
			}
		}

		return () => {
			if (sequence !== this.loadSequence) return;
			// Same variable + grid geometry -> blend the data values of old and new
			// frame in the shader. Anything else swaps instantly.
			if (this.current && this.fadeMs > 0 && this.current.gridSignature === frame.gridSignature) {
				if (frame.values === this.current.values) {
					// Same data re-committed (e.g. a viewport refresh after moveend):
					// keep the in-flight blend state instead of snapping the morph,
					// and still adopt the frame's fresh render options.
					this.seamless = undefined;
					this.pendingSeamless = undefined;
					this.current = frame;
					this.map?.triggerRepaint();
					return;
				}
				// A commit landing mid-blend continues from the values on screen:
				// the half-blended field becomes the new morph origin instead of
				// jumping to the old target first.
				this.previous = {
					values: this.blendSnapshot() ?? this.current.values,
					gridUniforms: this.current.gridUniforms
				};
				this.arrowPrevSampler = this.current.sampler;
				// Same grid geometry, so the particle pass can morph the wind
				// components from the replaced frame's own arrays.
				this.particlePrev = this.current.directions
					? { values: this.current.values, directions: this.current.directions }
					: undefined;
				this.fadeStart = performance.now();
			} else if (this.current && this.fadeMs > 0 && recropped) {
				this.particlePrev = undefined;
				if (recropped === frame.values) {
					// Same field re-cropped (a moveend refresh): swap silently.
					this.previous = undefined;
					this.arrowPrevSampler = undefined;
				} else {
					// Morph from the shown field re-resolved on the new geometry.
					this.previous = { values: recropped, gridUniforms: frame.gridUniforms };
					this.arrowPrevSampler = this.current.sampler;
					this.fadeStart = performance.now();
				}
			} else {
				this.previous = undefined;
				this.arrowPrevSampler = undefined;
				this.particlePrev = undefined;
				this.beginCrossfade();
			}

			this.seamless = undefined;
			this.pendingSeamless = undefined;
			this.current = frame;
			this.arrowGeneration++;
			this.map?.triggerRepaint();
		};
	}

	/** Origin of the uncropped grid; anchors the downsampled contour blocks. */
	private static fullOriginOf(
		grid: GridData,
		gridUniforms: GpuGridUniforms
	): [number, number] | undefined {
		if (gridUniforms.gridKind === 'gaussian') return undefined;
		const full = computeGridUniforms(grid, null);
		return [full.originX, full.originY];
	}

	/** Blend-compatibility identity: grid geometry plus variable and domain. */
	private static frameSignature(
		gridUniforms: GpuGridUniforms,
		variable: unknown,
		domainValue: string
	): string {
		return JSON.stringify({
			...gridUniforms,
			quad: undefined,
			variable,
			domain: domainValue
		});
	}

	/**
	 * The field currently on screen mid-blend (CPU lerp of previous into
	 * current), or undefined when no blend is in flight. A commit landing
	 * mid-blend morphs from this snapshot, so the visual never jumps.
	 */
	private blendSnapshot(): Float32Array | undefined {
		if (!this.previous || !this.current || this.fadeMs <= 0) return undefined;
		const mix = (performance.now() - this.fadeStart) / this.fadeMs;
		if (mix <= 0 || mix >= 1) return undefined;
		const from = this.previous.values;
		const to = this.current.values;
		if (from.length !== to.length) return undefined;
		const out = new Float32Array(from.length);
		for (let i = 0; i < from.length; i++) {
			out[i] = from[i] + (to[i] - from[i]) * mix;
		}
		return out;
	}

	/** True when every loaded sub-layer of `next` carries the same value arrays as `old`. */
	private sameSeamlessData(old: SeamlessFrame, next: SeamlessFrame): boolean {
		if (old.domain.value !== next.domain.value) return false;
		if (old.request.dataOptions.variable !== next.request.dataOptions.variable) return false;
		let loaded = 0;
		for (const [domainValue, entry] of next.entries) {
			if (entry.status !== 'loaded' || !entry.data) continue;
			loaded++;
			const oldEntry = old.entries.get(domainValue);
			if (oldEntry?.status !== 'loaded' || oldEntry.data?.values !== entry.data.values) {
				return false;
			}
		}
		return loaded > 0;
	}

	/** Mid-blend CPU lerp per sub-domain, the seamless counterpart of blendSnapshot. */
	private seamlessBlendSnapshot(
		old: SeamlessFrame | undefined
	): Map<string, Float32Array> | undefined {
		if (!old || !this.seamlessPrev || this.fadeMs <= 0) return undefined;
		const mix = (performance.now() - this.fadeStart) / this.fadeMs;
		if (mix <= 0 || mix >= 1) return undefined;
		const out = new Map<string, Float32Array>();
		for (const [domainValue, prev] of this.seamlessPrev) {
			const entry = old.entries.get(domainValue);
			const to = entry?.status === 'loaded' ? entry.data?.values : undefined;
			if (!to || to.length !== prev.values.length) continue;
			const from = prev.values;
			const lerped = new Float32Array(to.length);
			for (let i = 0; i < to.length; i++) {
				lerped[i] = from[i] + (to[i] - from[i]) * mix;
			}
			out.set(domainValue, lerped);
		}
		return out.size > 0 ? out : undefined;
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
	 * Configure (or remove) the animated wind-particle pass: particles advect
	 * through the wind field and leave fading trails. Requires data with
	 * directions (wind variables); renders continuously while configured.
	 */
	setParticles(config: GpuParticleConfig | undefined): void {
		this.particles = config;
		if (!config) {
			this.particleSystem?.dispose();
			this.particleSystem = undefined;
			this.particleLastTime = 0;
		}
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

	/** Screen pixels one grid cell spans at the current zoom. */
	private cellPxOf(gridUniforms: GpuGridUniforms): number {
		return (
			(WeatherGpuLayer.cellSizeDeg(gridUniforms) / 360) *
			512 *
			Math.pow(2, this.map?.getZoom() ?? 0)
		);
	}

	/** The draw-ready contour styling for a frame's levels, if configured. */
	private contourStyleDraw(intervals: number[], opacity: number): GpuContourDraw | undefined {
		const style = this.contours;
		if (!style || intervals.length === 0 || opacity <= 0) return undefined;

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

	/**
	 * Contour pass with a resolution fade: the bilinear derivative only settles
	 * once a cell spans several pixels, below that isolines crumble into
	 * speckle. Used where the downsampled pass (regular grids) is unavailable.
	 */
	private contourDrawOf(
		intervals: number[],
		opacity: number,
		gridUniforms: GpuGridUniforms
	): GpuContourDraw | undefined {
		const t = Math.min(1, Math.max(0, (this.cellPxOf(gridUniforms) - 3) / 2));
		const resolutionFade = t * t * (3 - 2 * t);
		if (resolutionFade <= 0) return undefined;
		return this.contourStyleDraw(intervals, opacity * resolutionFade);
	}

	/** Target cell size for the isolines; downsample the field below it. */
	private static readonly CONTOUR_TARGET_CELL_PX = 4;

	/**
	 * Contours of a downsampled copy of a regular-grid frame: at low zoom the
	 * full-resolution field speckles, so the isolines sample a coarser copy
	 * whose cells stay comfortably above a pixel — smooth world-view isobars
	 * instead of hiding them. Returns the extra lines-only draw, or undefined
	 * when the frame should render its contours in the main pass instead.
	 */
	private contourDownsampledDraw(
		frame: PlainFrame,
		opacity: number,
		mix: number
	): { layer: GpuLayerDraw; draw: GpuContourDraw; prevTexture?: WebGLTexture } | undefined {
		const g = frame.gridUniforms;
		// Regular and projected grids are both rectangular lattices over their
		// own axes, so one box downsample covers them; gaussian rows differ in
		// length and keep the resolution-faded full-res pass instead.
		if (g.gridKind === 'gaussian') return undefined;
		const cellPx = this.cellPxOf(g);
		if (cellPx >= WeatherGpuLayer.CONTOUR_TARGET_CELL_PX) return undefined;

		const draw = this.contourStyleDraw(frame.intervals, opacity);
		if (!draw) return undefined;
		// The box-averaged field is smooth by construction, so the anti-speckle
		// crowding fade only tears here: its 3..7px band sits exactly where the
		// coarse cells put dense isobars, and cell-scale fwidth variation flips
		// it per pixel. Scale minGap to move the band down to ~1.2..2.8px, where
		// lines genuinely stop resolving.
		draw.minGap *= 2.5;

		const factor = Math.min(
			32,
			Math.pow(2, Math.ceil(Math.log2(WeatherGpuLayer.CONTOUR_TARGET_CELL_PX / cellPx)))
		);
		// Anchor the coarse blocks to the full grid, not the viewport crop, so
		// the isolines stay put when panning re-crops the data.
		let skipX = 0;
		let skipY = 0;
		if (frame.fullOrigin) {
			const kx = Math.round((g.originX - frame.fullOrigin[0]) / g.dx);
			const ky = Math.round((g.originY - frame.fullOrigin[1]) / g.dy);
			skipX = ((-kx % factor) + factor) % factor;
			skipY = ((-ky % factor) + factor) % factor;
		}
		const ds = downsampleRegular(frame.values, g.nx, g.ny, factor, skipX, skipY);
		if (!ds) return undefined;

		// The coarse grid lives on the same axes (and projection) as the fine
		// one: box averaging over factor×factor cells puts the coarse cell
		// centre half a block further in than the (alignment-shifted) origin.
		// The quad and wrap flags carry over — the leftover wrap gap folds into
		// the double-width wrap cell.
		const renderer = this.renderer!;
		const gridUniforms: GpuGridUniforms = {
			...g,
			nx: ds.nx,
			ny: ds.ny,
			originX: g.originX + g.dx * (skipX + (factor - 1) / 2),
			originY: g.originY + g.dy * (skipY + (factor - 1) / 2),
			dx: g.dx * factor,
			dy: g.dy * factor,
			wrapLastCellDouble: g.lonWrap
		};
		const layer: GpuLayerDraw = {
			gridUniforms,
			valuesTexture: renderer.getValueTexture(
				ds.values,
				gridUniforms.nx,
				gridUniforms.ny,
				`${frame.stateKey}#ds${factor}`
			)
		};

		// Morph the coarse isolines with the temporal blend, like the raster.
		let prevTexture: WebGLTexture | undefined;
		if (mix < 1 && this.previous) {
			const prevDs = downsampleRegular(this.previous.values, g.nx, g.ny, factor, skipX, skipY);
			if (prevDs) {
				prevTexture = renderer.getValueTexture(prevDs.values, gridUniforms.nx, gridUniforms.ny);
			}
		}
		return { layer, draw, prevTexture };
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
		this.particleSystem?.dispose();
		this.particleSystem = undefined;
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
				this.particlePrev = undefined;
			}
		}

		// At full resolution the isolines share the main pass; at low zoom they
		// come from a downsampled copy of the field in an extra lines-only pass.
		let contours: GpuContourDraw | undefined;
		let extraContours: ReturnType<WeatherGpuLayer['contourDownsampledDraw']>;
		if (this.cellPxOf(frame.gridUniforms) >= WeatherGpuLayer.CONTOUR_TARGET_CELL_PX) {
			contours = this.contourStyleDraw(frame.intervals, opacity);
		} else {
			extraContours = this.contourDownsampledDraw(frame, opacity, mix);
			if (!extraContours) {
				contours = this.contourDrawOf(frame.intervals, opacity, frame.gridUniforms);
			}
		}

		const clipMask = frame.clipping?.polygons ? renderer.getClipMask(frame.clipping) : undefined;

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
				clipMask,
				worldOffsets: this.worldOffsets(projection),
				contours
			});
		}

		if (extraContours) {
			renderer.draw({
				projection,
				layers: [extraContours.layer],
				// Monotone (C1) sampling: bilinear isolines kink at every coarse
				// cell and their jumping derivative makes the crowding fade tear.
				interpolation: 'monotone',
				prevTexture: extraContours.prevTexture,
				mix: extraContours.prevTexture ? mix : 1,
				lut: renderer.getLut(frame.colorScale, frame.colorBlend),
				halfQuantum: frame.halfQuantum,
				opacity: 0,
				clipBounds: frame.clipBounds,
				clipMask,
				worldOffsets: this.worldOffsets(projection),
				contours: extraContours.draw
			});
		}

		if (!still) {
			this.drawArrowPass(gl, projection, frame.sampler, mix, opacity, frame.clipBounds, frame);
			this.drawParticlePass(
				projection,
				this.plainParticleLayers(frame),
				this.plainParticlePrev(frame, mix),
				mix,
				opacity,
				frame.clipBounds
			);
		}
	}

	/** The particle pass's wind-component layer for a plain frame, if wind data. */
	private plainParticleLayers(frame: PlainFrame): ParticleFieldLayer[] {
		if (!frame.directions || !this.particles) return [];
		const uv = windComponentsOf(frame.values, frame.directions);
		const g = frame.gridUniforms;
		const renderer = this.renderer!;
		return [
			{
				gridUniforms: g,
				uTexture: renderer.getValueTexture(uv.u, g.nx, g.ny),
				vTexture: renderer.getValueTexture(uv.v, g.nx, g.ny)
			}
		];
	}

	/** Previous-timestep component textures while a blendable morph is in flight. */
	private plainParticlePrev(
		frame: PlainFrame,
		mix: number
	): { uTexture: WebGLTexture; vTexture: WebGLTexture } | undefined {
		if (mix >= 1 || !this.particlePrev || !this.particles) return undefined;
		// particlePrev is only set for same-geometry commits, so the previous
		// arrays share the current frame's texture dimensions.
		const uv = windComponentsOf(this.particlePrev.values, this.particlePrev.directions);
		const g = frame.gridUniforms;
		const renderer = this.renderer!;
		return {
			uTexture: renderer.getValueTexture(uv.u, g.nx, g.ny),
			vTexture: renderer.getValueTexture(uv.v, g.nx, g.ny)
		};
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

		// A sub-layer without a previous state (e.g. loaded after the commit)
		// blends from its own values — identity for that layer, so a late join
		// no longer snaps the whole composite's morph.
		if (mix < 1) {
			for (const layer of drawLayers) layer.prevTexture ??= layer.valuesTexture;
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
				clipMask: frame.clipping?.polygons ? renderer.getClipMask(frame.clipping) : undefined,
				worldOffsets: this.worldOffsets(projection),
				contours
			});
		}

		if (!still && this.arrows) {
			this.updateSeamlessSampler(frame, drawnData);
			this.drawArrowPass(gl, projection, frame.sampler, mix, opacity, frame.clipBounds, frame);
		}
		if (!still) {
			this.drawParticlePass(
				projection,
				this.seamlessParticleLayers(drawnData),
				undefined,
				1,
				opacity,
				frame.clipBounds
			);
		}
	}

	/**
	 * The particle pass's component layers for a seamless composite: the same
	 * finest-first stack (and edge-blend state) as the raster draw, sampled on
	 * the wind components. All drawn sub-layers must carry directions, or the
	 * composite would blend against missing layers differently than the raster.
	 */
	private seamlessParticleLayers(drawn: GpuSeamlessLayerData[]): ParticleFieldLayer[] {
		if (!this.particles || drawn.length === 0) return [];
		if (drawn.some((data) => !data.data.directions)) return [];
		const renderer = this.renderer!;
		return drawn.map((data) => {
			const uv = windComponentsOf(data.values, data.data.directions!);
			const g = data.gridUniforms;
			return {
				gridUniforms: g,
				uTexture: renderer.getValueTexture(uv.u, g.nx, g.ny),
				vTexture: renderer.getValueTexture(uv.v, g.nx, g.ny),
				blendWidthDeg: data.blendWidthDeg,
				nanTexture: data.nanField ? renderer.getValueTexture(data.nanField, g.nx, g.ny) : undefined
			};
		});
	}

	/**
	 * Previous-timestep values per sub-domain when two composites can blend:
	 * same seamless domain, same variable, and matching sub-layers on identical
	 * grid geometry. Sub-layers without a usable counterpart just get no entry
	 * (they render with themselves as previous, so the rest still morphs).
	 */
	private seamlessPrevOf(
		old: SeamlessFrame | undefined,
		next: SeamlessFrame,
		/** Mid-blend snapshot values overriding the old frame's, per sub-domain. */
		snapshot?: Map<string, Float32Array>
	): Map<string, { values: Float32Array; nx: number; ny: number }> | undefined {
		if (!old || this.fadeMs <= 0) return undefined;
		if (old.domain.value !== next.domain.value) return undefined;
		if (old.request.dataOptions.variable !== next.request.dataOptions.variable) return undefined;

		const uniformsKey = (g: GpuGridUniforms): string => JSON.stringify({ ...g, quad: undefined });
		const prev = new Map<string, { values: Float32Array; nx: number; ny: number }>();
		for (const [domainValue, entry] of next.entries) {
			if (entry.status !== 'loaded' || !entry.data) continue;
			const oldEntry = old.entries.get(domainValue);
			if (oldEntry?.status !== 'loaded' || !oldEntry.data) continue;
			const g = oldEntry.data.gridUniforms;
			if (uniformsKey(entry.data.gridUniforms) !== uniformsKey(g)) continue;
			prev.set(domainValue, {
				values: snapshot?.get(domainValue) ?? oldEntry.data.values,
				nx: g.nx,
				ny: g.ny
			});
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
		clipBounds: Bounds | undefined,
		style: RenderStyle
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
		// Anchors outside the clip polygons are dropped like the rect clip drops
		// them — arrows over a masked-out raster would look detached.
		style.clipTester ??= createClippingTester(style.clipping) ?? null;
		const anchors = buildArrowAnchors(
			view,
			map.getZoom(),
			config.spacingPx,
			clipBounds,
			style.clipTester ?? undefined
		);
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

	/**
	 * The animated wind-particle pass: advance the GPU particle state by one
	 * step and composite the fading trail image. Requests a repaint every frame
	 * while active — the animation is the reason the map keeps rendering.
	 */
	private drawParticlePass(
		projection: GpuDrawOptions['projection'],
		layers: ParticleFieldLayer[],
		prev: { uTexture: WebGLTexture; vTexture: WebGLTexture } | undefined,
		mix: number,
		opacity: number,
		clipBounds: Bounds | undefined
	): void {
		const config = this.particles;
		if (!config || layers.length === 0 || !this.rendererGl) return;
		const map = this.map!;

		// Zoom gate with a one-level fade-in (and half-level fade-out above).
		const zoom = map.getZoom();
		const minZoom = config.minZoom ?? 0;
		const maxZoom = config.maxZoom ?? 24;
		const zoomFade =
			Math.min(1, Math.max(0, zoom - (minZoom - 1))) *
			Math.min(1, Math.max(0, maxZoom + 0.5 - zoom));
		if (zoomFade <= 0) {
			this.particleLastTime = 0;
			return;
		}

		this.particleSystem ??= new ParticleSystem(this.rendererGl);
		if (!this.particleSystem.supported) return;

		// Live/respawn window: the viewport in mercator coordinates, expanded a
		// little so particles drift in from just outside, intersected with the
		// rectangular clip (particles over a clipped-away raster look detached).
		const bounds = map.getBounds();
		let minX = (bounds.getWest() + 180) / 360;
		let maxX = (bounds.getEast() + 180) / 360;
		let minY = lat2tile(Math.min(85.051129, bounds.getNorth()), 0);
		let maxY = lat2tile(Math.max(-85.051129, bounds.getSouth()), 0);
		const margin = 0.02 * Math.max(maxX - minX, maxY - minY);
		minX -= margin;
		maxX += margin;
		minY = Math.max(0, minY - margin);
		maxY = Math.min(1, maxY + margin);
		if (clipBounds) {
			minX = Math.max(minX, (clipBounds[0] + 180) / 360);
			maxX = Math.min(maxX, (clipBounds[2] + 180) / 360);
			minY = Math.max(minY, lat2tile(Math.min(85.051129, clipBounds[3]), 0));
			maxY = Math.min(maxY, lat2tile(Math.max(-85.051129, clipBounds[1]), 0));
		}
		if (maxX - minX >= 1) {
			minX = 0;
			maxX = 1;
		}
		if (maxX <= minX || maxY <= minY) return;

		const now = performance.now();
		const dt = this.particleLastTime > 0 ? Math.min(0.05, (now - this.particleLastTime) / 1000) : 0;
		this.particleLastTime = now;

		// A fixed screen speed per m/s at every zoom: physically the flow slows
		// hugely on screen when zooming in, visually it should just keep flowing.
		const speedPxPerSec = config.speedPxPerSec ?? 1.4;
		const mercPerMps = (speedPxPerSec * dt) / (512 * Math.pow(2, zoom));

		this.particleSystem.render({
			layers,
			prev,
			mix,
			projection,
			config,
			dtSeconds: dt,
			mercPerMps,
			bounds: [minX, minY, maxX, maxY],
			opacity: opacity * (config.opacity ?? 0.8) * zoomFade,
			sizeDevicePx: config.sizePx * map.getPixelRatio(),
			worldOffsets: this.worldOffsets(projection)
		});
		map.triggerRepaint();
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
