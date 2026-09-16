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
import { getProtocolInstance } from '../om-protocol-state';
import { boundsIncluded } from '../utils/bounds';
import { createClippingTester, resolveClippingOptions } from '../utils/clipping';
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
import type { ArrowAnchors, ArrowSampler, GpuArrowConfig } from './arrows';
import { loadOmUrl } from './data';
import { downsampleRegular } from './downsample';
import { computeGridUniforms } from './grid-uniforms';
import type { GpuGridUniforms } from './grid-uniforms';
import { ParticleSystem, getCachedWindUV, setCachedWindUV, windComponentsOf } from './particles';
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
import { SurfaceTarget } from './surface-target';
import { TerrainElevationBuilder } from './terrain-elevation';
import type { GpuElevationMap, TerrainSource } from './terrain-elevation';

import type {
	Bounds,
	ClippingOptions,
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

/** One candidate wind for the advected temporal blend (see setAdvection). */
export interface GpuAdvectionSource {
	/** u-component variable name; the v sibling derives via the protocol rules. */
	variable: string;
	/**
	 * Multiplier on the advection displacement. Precipitation cells move with
	 * the steering-level flow (~700 hPa); a surface-wind fallback
	 * underestimates that, the two blended copies misalign, and the visual
	 * peak see-saws around high-value cores while the envelope translates
	 * smoothly. ~1.7 roughly compensates for 10 m winds. @default 1
	 */
	speedFactor?: number;
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
	/** Wind components for the advected temporal blend (setAdvection). */
	advU?: Float32Array;
	advV?: Float32Array;
	/** Displacement multiplier of the advection wind that loaded (steering factor). */
	advectFactor?: number;
	/** Valid time parsed from the URL, for the advection displacement scale. */
	timeMs?: number;
	gridUniforms: GpuGridUniforms;
	/** Identity of the grid geometry; temporal blending requires equal signatures. */
	gridSignature: string;
	halfQuantum: number;
	/** Wind sampler for the arrow pass; only set when the data has directions. */
	sampler?: ArrowSampler;
	/** URL-state key, labelling the texture for residency queries. */
	stateKey: string;
	/** Domain + variable identity, for the particle reseed on data switches. */
	dataKey: string;
	/** Full domain extent (lon/lat), for the particle budget of limited-area
	 *  domains zoomed far out. */
	domainBounds?: Bounds;
	/** The crop the data was loaded for, for the particle churn on expansion. */
	cropBounds?: Bounds;
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

/** Optical-flow results keyed by the incoming values array (one pair each). */
const flowCache = new WeakMap<
	Float32Array,
	{ prev: Float32Array; u: Float32Array; v: Float32Array }
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
	 * Per sub-domain reveal factor 0..1: a finer sub-layer joining the drawn
	 * composite (lazy load finishing, zoom entering its range) ramps up and
	 * morphs out of the coarser field; one leaving ramps down and morphs back —
	 * instead of the resolution popping. The composite identity resets the map
	 * (a domain/variable switch dissolves as a whole and must not also morph).
	 */
	private seamlessReveal = new Map<string, number>();
	private seamlessRevealKey: string | undefined;
	private seamlessRevealTime = 0;
	private static readonly SEAMLESS_REVEAL_MS = 500;
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
	/** Wind candidates powering the advected temporal blend, tried in order. */
	private advectSources: GpuAdvectionSource[] = [];
	/** `domain|variable` advection candidates that failed, skipped from then on. */
	private advectUnavailable = new Set<string>();
	/** Valid time of the frame the current blend morphs from. */
	private previousTimeMs: number | undefined;
	private particleSystem: ParticleSystem | undefined;
	/** Composites the map's terrain tiles into the elevation map (3D terrain). */
	private elevationBuilder: TerrainElevationBuilder | undefined;
	/** Offscreen target making the draped layer a solid surface (3D terrain). */
	private surface: SurfaceTarget | undefined;
	/** Last particle-update timestamp; 0 restarts the step clock. */
	private particleLastTime = 0;
	/** Identity of the field the particles advect through (seamless sub-layer
	 *  set); a change reseeds the population. undefined = nothing drawn yet. */
	private particleDataKey: string | undefined;
	/** Previous-timestep wind of a blendable commit, for the particle morph. */
	private particlePrev: { values: Float32Array; directions: Float32Array } | undefined;
	/** Sampler of the outgoing frame, for rebuilding instances mid-blend. */
	private arrowPrevSampler: ArrowSampler | undefined;
	/** Bumped whenever the arrow data changes; part of the instance identity. */
	private arrowGeneration = 0;
	private arrowInstanceKey = '';
	/** Last anchor lattice, reused while the view/lattice identity holds. */
	private arrowAnchors: ArrowAnchors | undefined;
	/** Tester the cached lattice was filtered with (identity check only). */
	private arrowAnchorTester: ((lon: number, lat: number) => boolean) | null | undefined;

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
	 * Restyle the clipping of what is already on screen, without reloading any
	 * data: the polygons re-rasterise into a fresh clip mask, the arrow lattice
	 * re-filters, and the next frame draws with the new outline. This is the
	 * live path for interactive polygon draws/drags — the host still updates
	 * its settings (and re-issues the URL) when the edit is finished, so the
	 * data crop catches up then.
	 *
	 * Note the crop caveat: the on-screen data was loaded for the previous
	 * clipping's bounds, so regions a drag exposes beyond that crop stay empty
	 * until the finishing reload.
	 *
	 * `maskMaxPx` caps the clip-mask resolution: interactive previews pass a
	 * lower cap so each restyle re-rasterises and uploads a fraction of the
	 * full-quality mask the finishing reload will build.
	 */
	setClipping(options: ClippingOptions, maskMaxPx?: number): void {
		const resolved = resolveClippingOptions(options);
		if (resolved && maskMaxPx !== undefined) resolved.maskMaxPx = maskMaxPx;
		const apply = (frame: RenderStyle | undefined): void => {
			if (!frame) return;
			frame.clipping = resolved;
			frame.clipBounds = resolved?.bounds;
			frame.clipTester = undefined;
		};
		apply(this.current);
		apply(this.seamless);
		apply(this.pendingSeamless);
		this.map?.triggerRepaint();
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
			// A crop change breaks per-sub-layer geometry equality, which used to
			// degrade every pan/zoom-adjacent commit into a crossfade: re-resolve
			// the outgoing composite's sub-layers on the incoming crop (mostly
			// cache-served) so the commit can morph values instead.
			const recroppedPrev = await this.recropSeamlessPrev(frame, signal);
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
				this.seamlessPrev = this.seamlessPrevOf(old, frame, snapshot, recroppedPrev);
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

		// Advected blend. Preferred displacement source: optical flow between
		// the outgoing and incoming fields themselves — a steering wind only
		// approximates how the features move, and any mismatch either splits
		// peaks into lobes (under-shoot) or makes the interior race and snap
		// back (over-shoot). Falls back to the wind candidates below when no
		// compatible previous frame or worker is available.
		let advU: Float32Array | undefined;
		let advV: Float32Array | undefined;
		let advectFactor: number | undefined;
		if (this.advectSources.length > 0 && gridUniforms.gridKind === 'regular') {
			const shownFrame = this.current;
			const timeMs = WeatherGpuLayer.timeOf(url);
			const flowDtSec =
				shownFrame?.timeMs !== undefined && timeMs !== undefined
					? (timeMs - shownFrame.timeMs) / 1000
					: 0;
			if (
				shownFrame &&
				shownFrame.gridSignature === gridSignature &&
				shownFrame.values !== values &&
				flowDtSec !== 0 &&
				Math.abs(flowDtSec) <= 6 * 3600
			) {
				const cached = flowCache.get(values);
				if (cached && cached.prev === shownFrame.values) {
					advU = cached.u;
					advV = cached.v;
					advectFactor = 1;
				} else {
					const decodeWorker = getProtocolInstance(this.settings).decodeWorker;
					if (decodeWorker && !decodeWorker.broken) {
						try {
							const flow = await decodeWorker.flow(
								shownFrame.values,
								values,
								gridUniforms.nx,
								gridUniforms.ny,
								gridUniforms.dx,
								gridUniforms.dy,
								gridUniforms.originY,
								flowDtSec
							);
							if (sequence !== this.loadSequence) return null;
							if (flow) {
								flowCache.set(values, { prev: shownFrame.values, u: flow.u, v: flow.v });
								advU = flow.u;
								advV = flow.v;
								advectFactor = 1;
							}
						} catch {
							// Wind fallback below.
						}
					}
				}
			}
		}
		for (const source of advU ? [] : this.advectSources) {
			const unavailableKey = `${loaded.domain.value}|${source.variable}`;
			if (this.advectUnavailable.has(unavailableKey)) continue;
			try {
				const windUrl = url.replace(/([?&])variable=[^&]*/, `$1variable=${source.variable}`);
				const wind = await loadOmUrl(windUrl, this.settings, signal);
				if (sequence !== this.loadSequence) return null;
				if (wind.data.values && wind.data.directions) {
					const windUniforms = computeGridUniforms(wind.domain.grid, wind.ranges);
					if (windUniforms.nx === gridUniforms.nx && windUniforms.ny === gridUniforms.ny) {
						await this.primeWindUV(wind.data.values, wind.data.directions);
						if (sequence !== this.loadSequence) return null;
						const uv = windComponentsOf(wind.data.values, wind.data.directions);
						advU = uv.u;
						advV = uv.v;
						advectFactor = source.speedFactor;
						break;
					}
				}
				this.advectUnavailable.add(unavailableKey);
			} catch (error) {
				if (error instanceof Error && error.name === 'AbortError') return null;
				this.advectUnavailable.add(unavailableKey);
			}
		}

		const frame: PlainFrame = {
			values,
			directions,
			advU,
			advV,
			advectFactor,
			timeMs: WeatherGpuLayer.timeOf(url),
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
			dataKey: `${loaded.domain.value}|${loaded.request.dataOptions.variable}`,
			domainBounds: GridFactory.create(loaded.domain.grid, null).getBounds() as Bounds,
			cropBounds: loaded.request.dataOptions.bounds,
			intervals: renderOptions.intervals,
			url,
			fullOrigin: WeatherGpuLayer.fullOriginOf(loaded.domain.grid, gridUniforms)
		};

		// Prime the wind components off the main thread while still preparing,
		// so the render path's windComponentsOf is a cache hit instead of a trig
		// loop over the whole grid.
		if (this.particles && directions) {
			await this.primeWindUV(values, directions);
			if (sequence !== this.loadSequence) return null;
		}

		// Warm the value textures so the commit itself never uploads mid-frame;
		// large grids stream in row chunks across frames instead of blocking a
		// mobile main thread with one multi-MB texImage2D.
		if (this.renderer) {
			const g = gridUniforms;
			await this.renderer.warmValueTexture(values, g.nx, g.ny, frame.stateKey);
			if (sequence !== this.loadSequence) return null;
			for (const extra of [advU, advV, getCachedWindUV(values)?.u, getCachedWindUV(values)?.v]) {
				if (!extra) continue;
				await this.renderer.warmValueTexture(extra, g.nx, g.ny);
				if (sequence !== this.loadSequence) return null;
			}
		}

		// A viewport-crop change cannot blend against the shown frame directly:
		// it lives on different grid geometry. Re-resolve the shown URL — the
		// protocol crops against the *current* viewport, mostly from cache — so
		// the commit can morph values on the new geometry instead of dissolving.
		let recropped: Float32Array | undefined;
		const shown = this.current;
		if (shown && this.fadeMs > 0 && shown.gridSignature !== frame.gridSignature) {
			try {
				// exactCrop: on zoom-in the shown URL's state still holds its old,
				// larger crop and included-bounds reuse would hand that back — the
				// geometry check below then fails and the commit dissolves instead
				// of morphing.
				const prev = await loadOmUrl(shown.url, this.settings, signal, true);
				if (sequence !== this.loadSequence) return null;
				const prevUniforms = computeGridUniforms(prev.domain.grid, prev.ranges);
				const prevSignature = WeatherGpuLayer.frameSignature(
					prevUniforms,
					prev.request.dataOptions.variable,
					prev.domain.value
				);
				if (prevSignature === frame.gridSignature && prev.data.values) {
					recropped = prev.data.values;
					await this.renderer?.warmValueTexture(recropped, prevUniforms.nx, prevUniforms.ny);
					if (sequence !== this.loadSequence) return null;
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
				this.previousTimeMs = this.current.timeMs;
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
					this.previousTimeMs = this.current.timeMs;
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

	/** Valid time parsed from the om URL's file segment (UTC ms), if present. */
	private static timeOf(url: string): number | undefined {
		const m = url.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})\.om/);
		if (!m) return undefined;
		return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
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
	 * Configure (or remove) the wind-advected temporal blend: while a timestep
	 * morph is in flight, the scalar field (precipitation, cloud cover, …) is
	 * sampled upstream/downstream of the wind displacement so features drift
	 * with the flow instead of cross-fading in place. Candidates are tried in
	 * order per prepared URL (e.g. a steering-level wind first, the surface
	 * wind with a speed factor as fallback); a candidate that fails for a
	 * domain is remembered and skipped, and with none left the blend stays
	 * plain. Takes effect on the next prepareUrl/setUrl.
	 */
	setAdvection(wind: GpuAdvectionSource[] | string | undefined): void {
		this.advectSources = typeof wind === 'string' ? [{ variable: wind }] : wind ? [...wind] : [];
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

	/**
	 * Contour source layers for a seamless composite: every drawn sub-layer
	 * whose cells span too few screen pixels is replaced by a box-downsampled
	 * copy on the same axes (per-layer factor, blocks anchored to the full
	 * grid), the rest reuse the raster textures as they are. The result renders
	 * as one extra lines-only multi-layer pass, so the isolines cross
	 * sub-domain edges with the same blend (and reveal morph) as the raster.
	 */
	private seamlessContourLayers(
		frame: SeamlessFrame,
		drawLayers: GpuLayerDraw[],
		drawnData: GpuSeamlessLayerData[],
		opacity: number,
		mix: number
	): { layers: GpuLayerDraw[]; draw: GpuContourDraw } | undefined {
		const draw = this.contourStyleDraw(frame.intervals, opacity);
		if (!draw) return undefined;
		// Same crowding-band shift as contourDownsampledDraw: the box-averaged
		// field is smooth, so the anti-speckle fade would only tear where the
		// coarse cells put dense isobars.
		draw.minGap *= 2.5;

		const renderer = this.renderer!;
		const layers = drawnData.map((data, i): GpuLayerDraw => {
			const g = data.gridUniforms;
			const cellPx = this.cellPxOf(g);
			// Gaussian rows differ in length; that sub-layer keeps full res (in
			// practice seamless sub-layers are regular or projected lattices).
			if (cellPx >= WeatherGpuLayer.CONTOUR_TARGET_CELL_PX || g.gridKind === 'gaussian') {
				return drawLayers[i];
			}
			const factor = Math.min(
				32,
				Math.pow(2, Math.ceil(Math.log2(WeatherGpuLayer.CONTOUR_TARGET_CELL_PX / cellPx)))
			);
			let skipX = 0;
			let skipY = 0;
			if (data.fullOrigin) {
				const kx = Math.round((g.originX - data.fullOrigin[0]) / g.dx);
				const ky = Math.round((g.originY - data.fullOrigin[1]) / g.dy);
				skipX = ((-kx % factor) + factor) % factor;
				skipY = ((-ky % factor) + factor) % factor;
			}
			const ds = downsampleRegular(data.values, g.nx, g.ny, factor, skipX, skipY);
			if (!ds) return drawLayers[i]; // crop too small to coarsen further
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
			// Morph the coarse isolines with the temporal blend, like the raster.
			let prevTexture: WebGLTexture | undefined;
			const prev = mix < 1 ? this.seamlessPrev?.get(data.domain.value) : undefined;
			if (prev && prev.nx === g.nx && prev.ny === g.ny) {
				const prevDs = downsampleRegular(prev.values, g.nx, g.ny, factor, skipX, skipY);
				if (prevDs) prevTexture = renderer.getValueTexture(prevDs.values, prevDs.nx, prevDs.ny);
			}
			return {
				gridUniforms,
				valuesTexture: renderer.getValueTexture(
					ds.values,
					ds.nx,
					ds.ny,
					`${data.stateKey}#ds${factor}`
				),
				// The NaN-distance texture lives on the full-res lattice; the
				// coarse copy blends on the domain rectangle alone.
				blendWidthDeg: data.blendWidthDeg,
				prevTexture,
				reveal: drawLayers[i].reveal
			};
		});
		// A layer without a downsampled previous still morphs the rest: blend
		// from itself (identity), like the raster composite.
		if (mix < 1) {
			for (const layer of layers) layer.prevTexture ??= layer.valuesTexture;
		}
		return { layers, draw };
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
		this.elevationBuilder?.dispose();
		this.elevationBuilder = undefined;
		this.surface?.dispose();
		this.surface = undefined;
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
		// With 3D terrain on, every pass lifts its vertices onto the ground:
		// MapLibre drapes only its built-in layer types, a custom layer would
		// stay a flat sheet at sea level.
		const terrain = (this.map as { terrain?: TerrainSource | null }).terrain;
		let elevation: GpuElevationMap | undefined;
		if (terrain) {
			this.elevationBuilder ??= new TerrainElevationBuilder(gl2);
			const built = this.elevationBuilder.update(terrain);
			if (built) {
				// Mercator z unit: the world's circumference at the centre latitude
				// (MapLibre's pixelsPerMeter / worldSize); the globe takes metres.
				const transition = args.defaultProjectionData.projectionTransition;
				const centreLat = (this.map.getCenter().lat * Math.PI) / 180;
				const mercPerMetre = 1 / (2 * Math.PI * 6371008.8 * Math.cos(centreLat));
				elevation = { ...built, scale: mercPerMetre + (1 - mercPerMetre) * transition };
			}
		}
		const projection: GpuDrawOptions['projection'] = {
			shaderData: args.shaderData,
			data: args.defaultProjectionData,
			elevation
		};
		// Over terrain the passes render into an offscreen target with a depth
		// pre-pass of the surface, so a ridge hides what lies behind it.
		if (elevation) {
			this.surface ??= new SurfaceTarget(gl2);
			this.surface.begin(this.renderer, projection, this.worldOffsets(projection));
		}

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

		if (elevation) this.surface!.end();
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

		// Advected blend: features drift along the wind between the timesteps.
		// The scales split the displacement across the morph (mix upstream,
		// 1 - mix downstream) and carry the sign of the step, so scrubbing
		// backwards rewinds the drift; a gap over 6h would fling features too far.
		let advect: GpuDrawOptions['advect'];
		if (mix < 1 && prevTexture && frame.advU && frame.advV) {
			const dtSec =
				frame.timeMs !== undefined && this.previousTimeMs !== undefined
					? (frame.timeMs - this.previousTimeMs) / 1000
					: 0;
			if (dtSec !== 0 && Math.abs(dtSec) <= 6 * 3600) {
				const g = frame.gridUniforms;
				const degPerMps = (dtSec / 111_320) * (frame.advectFactor ?? 1);
				advect = {
					uTexture: renderer.getValueTexture(frame.advU, g.nx, g.ny),
					vTexture: renderer.getValueTexture(frame.advV, g.nx, g.ny),
					prevDeg: mix * degPerMps,
					nextDeg: (1 - mix) * degPerMps
				};
			}
		}

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
				advect,
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
			// A domain or variable switch churns the particles: the old
			// population would visibly disperse out of the previous field. So
			// does polygon clipping appearing or clearing — the spawn window
			// jumps between the clip bounds and the whole viewport — and a crop
			// that EXPANDS past the previous one (new data after a pan or
			// zoom-out): dead slots would otherwise fill the newly covered
			// region only over a lifetime. A zoom-in (crop shrinks within the
			// old coverage) churns nothing.
			this.churnParticlesOnDataChange(
				frame.dataKey + (frame.clipping?.polygons ? '|clip' : ''),
				frame.cropBounds
			);
			this.drawParticlePass(
				projection,
				this.plainParticleLayers(frame),
				this.plainParticlePrev(frame, mix),
				mix,
				opacity,
				frame.clipBounds,
				clipMask,
				this.particleBudget(frame.domainBounds)
			);
		}
	}

	/**
	 * Budget falloff for limited-area domains: dead respawns retry until they
	 * land on valid data, so the population always concentrates in the
	 * footprint. budget = coverage^FALLOFF puts the density inside at
	 * coverage^(FALLOFF - 1) times the whole-viewport norm — a smooth boost
	 * that follows the zoom through the coverage itself: ~1x at full overlap,
	 * ~1.7x at half, ~19x for the ~2% footprint a high-res domain has at a
	 * world view. Lower = livelier when zoomed far out.
	 */
	private static readonly PARTICLE_BUDGET_FALLOFF = 0.25;
	/** Density cap over the norm, so sub-percent footprints stay sane. */
	private static readonly PARTICLE_DENSITY_MAX = 16;

	/**
	 * Particle budget (alive share, 0..1) for a frame's domain at the current
	 * view, from the domain's share of the viewport. Mercator areas, wrap-aware
	 * in x.
	 */
	private particleBudget(domainBounds: Bounds | undefined): number {
		if (!domainBounds || !this.map) return 1;
		const bounds = this.map.getBounds();
		const vx0 = (bounds.getWest() + 180) / 360;
		const vx1 = (bounds.getEast() + 180) / 360;
		const vy0 = lat2tile(Math.min(85.051129, bounds.getNorth()), 0);
		const vy1 = lat2tile(Math.max(-85.051129, bounds.getSouth()), 0);
		const viewSpanX = Math.min(1, vx1 - vx0);
		const viewArea = viewSpanX * (vy1 - vy0);
		if (!(viewArea > 0)) return 1;

		const dy0 = lat2tile(Math.min(85.051129, domainBounds[3]), 0);
		const dy1 = lat2tile(Math.max(-85.051129, domainBounds[1]), 0);
		const overlapY = Math.min(vy1, dy1) - Math.max(vy0, dy0);
		if (overlapY <= 0) return 1; // domain off-screen: nothing spawns anyway

		const dx0 = (domainBounds[0] + 180) / 360;
		let dx1 = (domainBounds[2] + 180) / 360;
		if (dx1 <= dx0) dx1 += 1; // dateline-crossing domain
		// Shift the domain by whole worlds onto the (possibly unwrapped)
		// viewport interval and take the best overlap.
		let overlapX = viewSpanX >= 1 ? dx1 - dx0 : 0;
		if (viewSpanX < 1) {
			for (let world = Math.floor(vx0 - dx0); world <= Math.ceil(vx1 - dx0); world++) {
				overlapX = Math.max(overlapX, Math.min(vx1, dx1 + world) - Math.max(vx0, dx0 + world));
			}
		}
		if (overlapX <= 0) return 1;

		const coverage = Math.min(1, (overlapX * overlapY) / viewArea);
		// Near-full coverage is full coverage: a global grid's lon span is a
		// cell short of 360° and must not gate anything.
		if (coverage > 0.95) return 1;
		return Math.min(
			1,
			Math.pow(coverage, WeatherGpuLayer.PARTICLE_BUDGET_FALLOFF),
			WeatherGpuLayer.PARTICLE_DENSITY_MAX * coverage
		);
	}

	/**
	 * Derive the wind components in the decode worker and seed the cache, so
	 * the render path's windComponentsOf never runs its trig loop over the
	 * whole grid on the main thread. No-ops without a worker (the sync
	 * fallback in windComponentsOf still applies) and on failure.
	 */
	private async primeWindUV(values: Float32Array, directions: Float32Array): Promise<void> {
		if (getCachedWindUV(values)) return;
		const decodeWorker = getProtocolInstance(this.settings).decodeWorker;
		if (!decodeWorker || decodeWorker.broken) return;
		try {
			setCachedWindUV(values, await decodeWorker.deriveUV(values, directions));
		} catch {
			// windComponentsOf computes inline on the next use.
		}
	}

	/** Crop bounds the particle population last settled on. */
	private particleCropBounds: Bounds | undefined;

	/**
	 * Churn the particle population — a fast but fluent turnover that keeps
	 * the trails (see ParticleSystem.churn) — when the advected field's
	 * identity changes (domain/variable/sub-layer set, polygon clipping
	 * appearing/clearing) or the data crop expands past the previous coverage
	 * (a pan or zoom-out that brought new data). A crop that shrinks within
	 * the old coverage (zoom-in) changes nothing worth churning for.
	 */
	private churnParticlesOnDataChange(dataKey: string, cropBounds?: Bounds): void {
		const cropExpanded =
			this.particleCropBounds !== undefined &&
			cropBounds !== undefined &&
			!boundsIncluded(cropBounds, this.particleCropBounds);
		if (this.particleDataKey === dataKey && !cropExpanded) {
			this.particleCropBounds = cropBounds ?? this.particleCropBounds;
			return;
		}
		if (this.particleDataKey !== undefined) this.particleSystem?.churn();
		this.particleDataKey = dataKey;
		this.particleCropBounds = cropBounds;
	}

	/** The particle pass's field layer for a plain frame. */
	private plainParticleLayers(frame: PlainFrame): ParticleFieldLayer[] {
		if (!this.particles) return [];
		const g = frame.gridUniforms;
		const renderer = this.renderer!;
		if (this.particles.mode === 'rain') {
			// Rain streaks sample the scalar field itself (e.g. precipitation);
			// the v slot is unused by the rain update shader.
			const values = renderer.getValueTexture(frame.values, g.nx, g.ny, frame.stateKey);
			return [{ gridUniforms: g, uTexture: values, vTexture: values }];
		}
		if (!frame.directions) return [];
		const uv = windComponentsOf(frame.values, frame.directions);
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
		if (this.particles.mode === 'rain') return undefined;
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

		// Advance the reveal factors first: they decide which loaded sub-layers
		// still draw. A fresh composite identity snaps them (that commit already
		// dissolves as a whole); within one identity a layer joining or leaving
		// the active set ramps over SEAMLESS_REVEAL_MS, morphing the fine field
		// out of (or back into) the coarser composite. With animation off
		// (fadeMs 0, like the timestep blend) the factors snap too. The outgoing
		// crossfade (still) renders with the factors as they stand.
		const activeSet = new Set(activeSeamlessLayers(frame.domain, zoom).map((l) => l.domainValue));
		const globalLayer = frame.domain.layers[frame.domain.layers.length - 1];
		let revealAnimating = false;
		if (!still) {
			const revealKey = `${frame.domain.value}|${String(frame.request.dataOptions.variable)}`;
			const now = performance.now();
			const step =
				this.seamlessRevealKey === revealKey && this.fadeMs > 0
					? Math.min(100, now - this.seamlessRevealTime) / WeatherGpuLayer.SEAMLESS_REVEAL_MS
					: 1;
			if (this.seamlessRevealKey !== revealKey) this.seamlessReveal.clear();
			this.seamlessRevealKey = revealKey;
			this.seamlessRevealTime = now;
			for (const layerDef of frame.domain.layers) {
				const entry = frame.entries.get(layerDef.domainValue);
				const target =
					activeSet.has(layerDef.domainValue) && entry?.status === 'loaded' && entry.data ? 1 : 0;
				const value = this.seamlessReveal.get(layerDef.domainValue) ?? 0;
				const next =
					target > value ? Math.min(target, value + step) : Math.max(target, value - step);
				if (next !== value) revealAnimating = true;
				this.seamlessReveal.set(layerDef.domainValue, next);
			}
			if (revealAnimating) this.map!.triggerRepaint();
		}

		const drawLayers: GpuLayerDraw[] = [];
		const drawnData: GpuSeamlessLayerData[] = [];
		let finestScaleFactor: number | undefined;
		for (const layerDef of frame.domain.layers) {
			const entry = frame.entries.get(layerDef.domainValue);
			if (entry?.status !== 'loaded' || !entry.data) continue;
			const isBase = layerDef === globalLayer;
			// A still (outgoing) frame has no factors of its own; it draws its
			// active set as committed.
			const reveal = isBase
				? 1
				: (this.seamlessReveal.get(layerDef.domainValue) ??
					(activeSet.has(layerDef.domainValue) ? 1 : 0));
			if (reveal <= 0.001) continue;
			const data = entry.data;
			const g = data.gridUniforms;
			const prev = mix < 1 ? this.seamlessPrev?.get(layerDef.domainValue) : undefined;
			drawLayers.push({
				gridUniforms: g,
				valuesTexture: renderer.getValueTexture(data.values, g.nx, g.ny, data.stateKey),
				blendWidthDeg: data.blendWidthDeg,
				nanTexture: data.nanField ? renderer.getValueTexture(data.nanField, g.nx, g.ny) : undefined,
				prevTexture: prev ? renderer.getValueTexture(prev.values, prev.nx, prev.ny) : undefined,
				reveal: isBase ? undefined : reveal
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

		const clipMask = frame.clipping?.polygons ? renderer.getClipMask(frame.clipping) : undefined;
		// Isolines: when every drawn sub-layer's cells span enough pixels they
		// share the main pass; otherwise (the finest layers activate right at
		// their legibility limit, where the full-res bilinear derivative
		// speckles) the lines come from per-layer downsampled copies in an
		// extra lines-only pass — the seamless counterpart of the plain path's
		// contourDownsampledDraw.
		let contours: GpuContourDraw | undefined;
		let extraContours: { layers: GpuLayerDraw[]; draw: GpuContourDraw } | undefined;
		if (
			drawnData.every(
				(data) => this.cellPxOf(data.gridUniforms) >= WeatherGpuLayer.CONTOUR_TARGET_CELL_PX
			)
		) {
			contours = this.contourStyleDraw(frame.intervals, opacity);
		} else {
			extraContours = this.seamlessContourLayers(frame, drawLayers, drawnData, opacity, mix);
		}
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
				clipMask,
				worldOffsets: this.worldOffsets(projection),
				contours
			});
		}

		if (extraContours) {
			renderer.draw({
				projection,
				layers: extraContours.layers,
				// Monotone (C1) sampling: bilinear isolines kink at every coarse
				// cell and their jumping derivative makes the crowding fade tear.
				interpolation: 'monotone',
				mix,
				lut: renderer.getLut(frame.colorScale, frame.colorBlend),
				halfQuantum: computeHalfQuantum(finestScaleFactor),
				opacity: 0,
				clipBounds: frame.clipBounds,
				clipMask,
				worldOffsets: this.worldOffsets(projection),
				contours: extraContours.draw
			});
		}

		if (!still && this.arrows) {
			this.updateSeamlessSampler(frame, drawnData);
			this.drawArrowPass(gl, projection, frame.sampler, mix, opacity, frame.clipBounds, frame);
		}
		if (!still) {
			// A lazily loaded (or zoom-toggled) sub-layer changes the field the
			// particles advect through; churn instead of letting the population
			// visibly disperse out of the previous composite's flow. The variable
			// and clip presence are part of the identity, the crop expansion is
			// checked separately — like the plain frame's.
			this.churnParticlesOnDataChange(
				`${String(frame.request.dataOptions.variable)}|${drawnData
					.map((data) => data.domain.value)
					.join('|')}${frame.clipping?.polygons ? '|clip' : ''}`,
				frame.request.dataOptions.bounds
			);
			this.drawParticlePass(
				projection,
				this.seamlessParticleLayers(drawnData, drawLayers),
				undefined,
				1,
				opacity,
				frame.clipBounds,
				clipMask
			);
		}
	}

	/**
	 * The particle pass's component layers for a seamless composite: the same
	 * finest-first stack (and edge-blend state) as the raster draw, sampled on
	 * the wind components. All drawn sub-layers must carry directions, or the
	 * composite would blend against missing layers differently than the raster.
	 */
	private seamlessParticleLayers(
		drawn: GpuSeamlessLayerData[],
		/** The raster draw layers (parallel to `drawn`), carrying the reveals. */
		drawLayers: GpuLayerDraw[]
	): ParticleFieldLayer[] {
		if (!this.particles || drawn.length === 0) return [];
		if (drawn.some((data) => !data.data.directions)) return [];
		const renderer = this.renderer!;
		return drawn.map((data, i) => {
			const uv = windComponentsOf(data.values, data.data.directions!);
			const g = data.gridUniforms;
			return {
				gridUniforms: g,
				uTexture: renderer.getValueTexture(uv.u, g.nx, g.ny),
				vTexture: renderer.getValueTexture(uv.v, g.nx, g.ny),
				blendWidthDeg: data.blendWidthDeg,
				nanTexture: data.nanField ? renderer.getValueTexture(data.nanField, g.nx, g.ny) : undefined,
				reveal: drawLayers[i].reveal
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
		snapshot?: Map<string, Float32Array>,
		/** Old values re-resolved on next's crop, for entries whose crop changed. */
		recropped?: Map<string, { values: Float32Array; nx: number; ny: number }>
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
			if (uniformsKey(entry.data.gridUniforms) !== uniformsKey(g)) {
				// Crop changed: morph from the re-resolved copy on the new geometry.
				const recroppedEntry = recropped?.get(domainValue);
				if (recroppedEntry) prev.set(domainValue, recroppedEntry);
				continue;
			}
			prev.set(domainValue, {
				values: snapshot?.get(domainValue) ?? oldEntry.data.values,
				nx: g.nx,
				ny: g.ny
			});
		}
		return prev.size > 0 ? prev : undefined;
	}

	/**
	 * The outgoing composite's sub-layer values re-resolved on the incoming
	 * frame's crop (mostly cache-served): geometry-compatible morph sources
	 * for sub-layers whose crop a pan/zoom changed. Same-timestep refreshes
	 * resolve to the incoming values themselves — an identity morph.
	 */
	private async recropSeamlessPrev(
		frame: SeamlessFrame,
		signal?: AbortSignal
	): Promise<Map<string, { values: Float32Array; nx: number; ny: number }> | undefined> {
		const old = this.seamless;
		if (!old || old === frame || this.fadeMs <= 0) return undefined;
		if (old.domain.value !== frame.domain.value) return undefined;
		if (old.request.dataOptions.variable !== frame.request.dataOptions.variable) return undefined;

		const uniformsKey = (g: GpuGridUniforms): string => JSON.stringify({ ...g, quad: undefined });
		const active = activeSeamlessLayers(frame.domain, this.map?.getZoom() ?? 0);
		const globalLayer = frame.domain.layers[frame.domain.layers.length - 1];
		const recropped = new Map<string, { values: Float32Array; nx: number; ny: number }>();
		for (const layerDef of active) {
			const entry = frame.entries.get(layerDef.domainValue);
			if (entry?.status !== 'loaded' || !entry.data) continue;
			const oldEntry = old.entries.get(layerDef.domainValue);
			if (oldEntry?.status !== 'loaded' || !oldEntry.data) continue;
			const g = entry.data.gridUniforms;
			if (uniformsKey(oldEntry.data.gridUniforms) === uniformsKey(g)) continue;
			try {
				const prev = await loadSeamlessLayer(
					{
						...old.request,
						dataOptions: { ...old.request.dataOptions, bounds: frame.request.dataOptions.bounds }
					},
					frame.domain,
					layerDef,
					layerDef === globalLayer,
					this.settings,
					active.length,
					signal,
					true
				);
				if (!prev || uniformsKey(prev.gridUniforms) !== uniformsKey(g)) continue;
				await this.renderer?.warmValueTexture(prev.values, g.nx, g.ny);
				recropped.set(layerDef.domainValue, { values: prev.values, nx: g.nx, ny: g.ny });
			} catch {
				// This sub-layer dissolves in via its self-prev; the rest still morph.
			}
		}
		return recropped.size > 0 ? recropped : undefined;
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
	 * The instanced arrow overlay. Anchors live on a map-fixed lattice whose
	 * visible density stays constant per screen (per-anchor pop-in thresholds
	 * gated by the fractional zoom, see buildArrowAnchors); the instance
	 * buffer is resampled only when the lattice, the data or the outgoing
	 * blend state changes — the per-frame cost is one instanced draw.
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
		// The anchors' key only records that a tester was present, so the cached
		// lattice must be dropped when the tester itself changes (new clipping).
		if (this.arrowAnchorTester !== style.clipTester) {
			this.arrowAnchorTester = style.clipTester;
			this.arrowAnchors = undefined;
		}
		const anchors = buildArrowAnchors(
			view,
			map.getZoom(),
			config.spacingPx,
			clipBounds,
			style.clipTester ?? undefined,
			// On the globe the lattice turns geographic (equal-area, no polar
			// convergence, bounded anchor count for globe-wide views).
			(projection?.data.projectionTransition ?? 0) > 0,
			this.arrowAnchors
		);
		this.arrowAnchors = anchors;
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
			zoomFrac: zoom - Math.floor(zoom),
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
		clipBounds: Bounds | undefined,
		clipMask?: { texture: WebGLTexture; rect: [number, number, number, number] },
		/** Alive share of the population (limited-area domain zoomed out). */
		budget = 1
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
		const speedPxPerSec =
			(config.speedPxPerSec ?? 1.4) *
			(1 + (config.zoomSpeedGain ?? 0) * Math.max(0, zoom - (config.zoomSpeedFrom ?? 8)));
		const mercPerMps = (speedPxPerSec * dt) / (512 * Math.pow(2, zoom));

		// Only a tilted camera skews the screen density of a mercator-uniform
		// respawn; flat views keep the window draw (with its drift-in margin).
		const tilted = map.getPitch() > 0.5;

		// The trail composite is a screen-space image: never depth-tested
		// against the terrain surface target.
		const render = (): void =>
			this.particleSystem!.render({
				layers,
				prev,
				mix,
				projection,
				config,
				clipMask,
				budget,
				dtSeconds: dt,
				mercPerMps,
				bounds: [minX, minY, maxX, maxY],
				globe: projection?.data.projectionTransition ?? 0,
				opacity: opacity * (config.opacity ?? 0.8) * zoomFade,
				sizeDevicePx: config.sizePx * map.getPixelRatio(),
				dashLenDevicePx: (config.dashLengthPx ?? 8) * map.getPixelRatio(),
				worldOffsets: this.worldOffsets(projection),
				depthTexture: projection?.elevation ? this.surface?.depthTexture : undefined,
				visibility: projection?.elevation ? this.surface?.visibilityMapOfFrame : undefined,
				screenSpawn: tilted
					? { groundMap: projection?.elevation ? this.surface?.groundMap : undefined }
					: undefined
			});
		if (projection?.elevation && this.surface) this.surface.withoutDepth(render);
		else render();
		map.triggerRepaint();
	}

	/** Kick loads for all zoom-active sub-layers that have no entry yet. */
	private async ensureSeamlessLoads(frame: SeamlessFrame, zoom: number): Promise<void> {
		const active = activeSeamlessLayers(frame.domain, zoom);
		const globalLayer = frame.domain.layers[frame.domain.layers.length - 1];
		// Sub-layers mid fade-out are loaded like active ones: a crop refresh
		// commits a fresh frame during the reveal ramp, and without an entry the
		// fading layer would pop out of the new composite instead of finishing
		// its morph back into the coarser field.
		const wanted = frame.domain.layers.filter(
			(layerDef) =>
				active.includes(layerDef) || (this.seamlessReveal.get(layerDef.domainValue) ?? 0) > 0
		);
		const loads: Promise<void>[] = [];
		for (const layerDef of wanted) {
			if (frame.entries.has(layerDef.domainValue)) continue;
			frame.entries.set(layerDef.domainValue, { status: 'loading' });
			loads.push(this.loadSeamlessEntry(frame, layerDef, layerDef === globalLayer, wanted.length));
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
		if (data) {
			// Same prepare-phase offloading as the plain path: derive the wind
			// components in the worker and stream the texture upload in chunks
			// before the entry becomes drawable.
			if (this.particles && data.data.directions) {
				await this.primeWindUV(data.values, data.data.directions);
			}
			if (this.renderer) {
				const g = data.gridUniforms;
				await this.renderer.warmValueTexture(data.values, g.nx, g.ny, data.stateKey);
				const uv = getCachedWindUV(data.values);
				for (const extra of [data.nanField, uv?.u, uv?.v]) {
					if (extra) await this.renderer.warmValueTexture(extra, g.nx, g.ny);
				}
			}
			if (this.seamless !== frame && this.pendingSeamless !== frame) return;
		}
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
