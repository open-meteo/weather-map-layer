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
 *   per pixel with the same smooth-step edge weights as the CPU worker.
 *
 * Data loading reuses the om protocol's URL grammar and state cache, so the
 * layer accepts the same om:// URLs as the CPU raster path. Call `setUrl`
 * again (same URL is fine) after significant viewport changes so viewport-
 * cropped data and seamless viewport gates can follow the map.
 */
import { isSeamlessDomain } from '../domain-helpers';
import { defaultOmProtocolSettings } from '../om-protocol';
import { halfQuantum as computeHalfQuantum } from '../utils/math';
import { parseRequest } from '../utils/parse-request';
import { normalizeUrl } from '../utils/parse-url';
import type {
	CustomLayerInterface,
	CustomRenderMethodInput,
	Map as MapLibreMap
} from 'maplibre-gl';

import { loadOmUrl } from './data';
import { computeGridUniforms } from './grid-uniforms';
import type { GpuGridUniforms } from './grid-uniforms';
import { WeatherGpuRenderer } from './renderer';
import type { GpuLayerDraw } from './renderer';
import { activeSeamlessLayers, loadSeamlessLayer } from './seamless-data';
import type { GpuSeamlessLayerData } from './seamless-data';

import type {
	Bounds,
	InterpolationMethod,
	OmProtocolSettings,
	ParsedRequest,
	RenderableColorScale,
	SeamlessDomain,
	SeamlessLayer
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
}

export class WeatherGpuLayer implements CustomLayerInterface {
	id: string;
	type = 'custom' as const;
	renderingMode = '2d' as const;

	private settings: OmProtocolSettings;
	private opacity: number;
	private fadeMs: number;

	private map: MapLibreMap | undefined;
	private renderer: WeatherGpuRenderer | undefined;

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

	/** Guards against out-of-order setUrl loads; only the latest wins. */
	private loadSequence = 0;
	private warnedGlobe = false;

	constructor(options: WeatherGpuLayerOptions = {}) {
		this.id = options.id ?? 'weather-gpu-layer';
		this.settings = options.settings ?? defaultOmProtocolSettings;
		this.opacity = options.opacity ?? 1;
		this.fadeMs = options.fadeMs ?? 250;
	}

	/**
	 * Points the layer at an om:// URL (meta-JSON forms like latest.json are
	 * resolved exactly like the tile protocol does). Seamless composite domains
	 * are supported: their sub-layers load lazily per zoom level. Resolves once
	 * the (first) data is loaded; the next frame will show it.
	 */
	async setUrl(omUrl: string, signal?: AbortSignal): Promise<void> {
		const sequence = ++this.loadSequence;

		const url = await normalizeUrl(omUrl, this.settings.domainOptions);
		const request = parseRequest(url, this.settings);
		if (sequence !== this.loadSequence) return; // superseded by a newer setUrl

		if (isSeamlessDomain(request.dataOptions.domain)) {
			const renderOptions = request.renderOptions;
			const frame: SeamlessFrame = {
				domain: request.dataOptions.domain,
				request,
				entries: new Map(),
				interpolation: renderOptions.interpolation,
				colorScale: renderOptions.colorScale,
				colorBlend: renderOptions.colorBlend,
				clipBounds: request.clippingOptions?.bounds
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
			if (sequence !== this.loadSequence) return;
			this.current = undefined;
			this.previous = undefined;
			this.seamless = frame;
			if (this.pendingSeamless === frame) this.pendingSeamless = undefined;
			this.map?.triggerRepaint();
			return;
		}

		const loaded = await loadOmUrl(omUrl, this.settings, signal);
		if (sequence !== this.loadSequence) return;

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

		// Same variable + grid geometry -> blend the data values of old and new
		// frame in the shader. Anything else swaps instantly.
		if (this.current && this.fadeMs > 0 && this.current.gridSignature === gridSignature) {
			this.previous = {
				values: this.current.values,
				gridUniforms: this.current.gridUniforms
			};
			this.fadeStart = performance.now();
		} else {
			this.previous = undefined;
		}

		this.seamless = undefined;
		this.pendingSeamless = undefined;
		this.current = {
			values,
			gridUniforms,
			gridSignature,
			interpolation: renderOptions.interpolation,
			colorScale: renderOptions.colorScale,
			colorBlend: renderOptions.colorBlend,
			halfQuantum: computeHalfQuantum(loaded.data.scaleFactor),
			clipBounds: loaded.request.clippingOptions?.bounds
		};
		this.map?.triggerRepaint();
	}

	setOpacity(opacity: number): void {
		this.opacity = opacity;
		this.map?.triggerRepaint();
	}

	onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
		if (!(gl instanceof WebGL2RenderingContext)) {
			throw new Error('gpu: WeatherGpuLayer requires a WebGL2 map context');
		}
		this.map = map;
		this.renderer = new WeatherGpuRenderer(gl);
	}

	onRemove(): void {
		this.renderer?.dispose();
		this.renderer = undefined;
		this.map = undefined;
	}

	render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
		if (!this.renderer || !this.map) return;

		const projectionData = args.defaultProjectionData;
		// Globe rendering needs the projection-specific shader prelude; until that
		// is implemented the mercator fallback matrix keeps the transition usable.
		let matrix = projectionData.mainMatrix;
		if (projectionData.projectionTransition > 0) {
			matrix = projectionData.fallbackMatrix;
			if (!this.warnedGlobe) {
				this.warnedGlobe = true;
				console.warn('WeatherGpuLayer: globe projection is not supported yet, rendering flat');
			}
		}

		if (this.seamless) {
			this.renderSeamless(matrix, this.seamless);
		} else if (this.current) {
			this.renderPlain(matrix, this.current);
		}
	}

	private renderPlain(matrix: ArrayLike<number>, frame: PlainFrame): void {
		const renderer = this.renderer!;

		let mix = 1;
		let prevTexture: WebGLTexture | undefined;
		if (this.previous) {
			mix = Math.min(1, (performance.now() - this.fadeStart) / this.fadeMs);
			if (mix < 1) {
				const prev = this.previous.gridUniforms;
				prevTexture = renderer.getValueTexture(this.previous.values, prev.nx, prev.ny);
				this.map!.triggerRepaint(); // keep animating the blend
			} else {
				this.previous = undefined;
			}
		}

		const g = frame.gridUniforms;
		renderer.draw({
			matrix,
			layers: [
				{
					gridUniforms: g,
					valuesTexture: renderer.getValueTexture(frame.values, g.nx, g.ny)
				}
			],
			interpolation: frame.interpolation,
			prevTexture,
			mix,
			lut: renderer.getLut(frame.colorScale, frame.colorBlend),
			halfQuantum: frame.halfQuantum,
			opacity: this.opacity,
			clipBounds: frame.clipBounds,
			worldOffsets: this.worldOffsets()
		});
	}

	private renderSeamless(matrix: ArrayLike<number>, frame: SeamlessFrame): void {
		const renderer = this.renderer!;
		const zoom = this.map!.getZoom();

		// Keep loads in sync with the zoom level: entering a finer layer's range
		// kicks its load; the frame renders with whatever is loaded meanwhile.
		void this.ensureSeamlessLoads(frame, zoom);

		const active = activeSeamlessLayers(frame.domain, zoom);
		const drawLayers: GpuLayerDraw[] = [];
		let finestScaleFactor: number | undefined;
		for (const layerDef of active) {
			const entry = frame.entries.get(layerDef.domainValue);
			if (entry?.status !== 'loaded' || !entry.data) continue;
			const data = entry.data;
			const g = data.gridUniforms;
			drawLayers.push({
				gridUniforms: g,
				valuesTexture: renderer.getValueTexture(data.values, g.nx, g.ny),
				blendWidthDeg: data.blendWidthDeg,
				nanTexture: data.nanField ? renderer.getValueTexture(data.nanField, g.nx, g.ny) : undefined
			});
			finestScaleFactor ??= data.scaleFactor;
		}
		if (drawLayers.length === 0) return;

		renderer.draw({
			matrix,
			layers: drawLayers,
			interpolation: frame.interpolation,
			lut: renderer.getLut(frame.colorScale, frame.colorBlend),
			// Same convention as the CPU worker: the primary (finest) layer's
			// quantisation step drives the colour threshold offset.
			halfQuantum: computeHalfQuantum(finestScaleFactor),
			opacity: this.opacity,
			clipBounds: frame.clipBounds,
			worldOffsets: this.worldOffsets()
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
	private worldOffsets(): number[] {
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
