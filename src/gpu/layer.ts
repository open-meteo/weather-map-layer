/**
 * A MapLibre custom layer that renders a scalar weather field directly in
 * the map's WebGL2 context — no tiles, no worker round-trips, no bitmaps.
 *
 * The grid values live in a float texture; every frame a fragment shader maps
 * each screen pixel (mercator -> lat/lon -> grid cell -> interpolation ->
 * colour LUT). Consequences:
 *
 * - restyling (colour scale, interpolation, opacity) is just a uniform/LUT
 *   change followed by a repaint — nothing is re-rendered tile by tile;
 * - a timestep change swaps a texture and cross-fades the two frames;
 * - zooming/panning never shows resampled stale tiles.
 *
 * Data loading reuses the om protocol's URL grammar and state cache, so the
 * layer accepts the same om:// URLs as the CPU raster path. Call `setUrl`
 * again (same URL is fine) after significant viewport changes so viewport-
 * cropped data can follow the map.
 *
 * `prepareUrl` splits the load from the visual swap: it resolves to a commit
 * callback once the data is ready, so a host showing several layers can load
 * them all first and commit them in the same frame (synchronised animation).
 * `setUrl` is prepare + immediate commit.
 */
import { variableHasDirections } from '../om-file-reader';
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
import type { GpuDrawOptions } from './renderer';

import type { InterpolationMethod, OmProtocolSettings, RenderableColorScale } from '../types';

export interface WeatherGpuLayerOptions {
	id?: string;
	settings?: OmProtocolSettings;
	/** Layer opacity 0..1. @default 1 */
	opacity?: number;
	/**
	 * Byte budget (in MB) for cached value textures in VRAM. More budget keeps
	 * more timesteps resident, so animation loops replay without re-uploads.
	 * @default 256
	 */
	textureCacheMb?: number;
}

interface Frame {
	values: Float32Array;
	gridUniforms: GpuGridUniforms;
	interpolation: InterpolationMethod;
	colorScale: RenderableColorScale;
	colorBlend: boolean;
	halfQuantum: number;
}

/**
 * One renderer per GL context, shared by every WeatherGpuLayer on the map:
 * programs, LUTs and value textures dedupe across layers, and the VRAM budget
 * is a single global figure instead of one per layer.
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
	private textureCacheMb: number | undefined;

	private map: MapLibreMap | undefined;
	private renderer: WeatherGpuRenderer | undefined;
	private rendererGl: WebGL2RenderingContext | undefined;

	private current: Frame | undefined;
	/**
	 * The replaced frame while a commit cross-fades: it keeps rendering
	 * underneath while the new one fades in on top, with an opacity
	 * compensation so the combined coverage never dips or over-darkens.
	 */
	private outgoing: Frame | undefined;
	private crossfadeStart = 0;
	private static readonly CROSSFADE_MS = 250;

	/** Guards against out-of-order setUrl loads; only the latest wins. */
	private loadSequence = 0;

	constructor(options: WeatherGpuLayerOptions = {}) {
		this.id = options.id ?? 'weather-gpu-layer';
		this.settings = options.settings ?? defaultOmProtocolSettings;
		this.opacity = options.opacity ?? 1;
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
	 * Replace the protocol settings (colour scales, domains, …) at runtime.
	 * Hosts keep these in a store the CPU protocol reads live per request; the
	 * GPU layer must follow the same object or it parses against stale options.
	 * Takes effect on the next prepareUrl/setUrl.
	 */
	setSettings(settings: OmProtocolSettings): void {
		this.settings = settings;
	}

	/**
	 * Points the layer at an om:// URL (meta-JSON forms like latest.json are
	 * resolved exactly like the tile protocol does). Resolves once the data is
	 * loaded and shown; the next frame will draw it.
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

		// The shader colour-maps one scalar per cell; a speed/direction pair has
		// no GPU representation here (arrows and barbs stay on the CPU path).
		const variable = request.dataOptions.variable;
		if (variableHasDirections(variable)) {
			throw new Error(`gpu: variable '${variable}' carries directions (scalar variables only)`);
		}

		const loaded = await loadOmUrl(url, this.settings, signal);
		if (sequence !== this.loadSequence) return null;

		const values = loaded.data.values;
		if (!values) {
			throw new Error('gpu: URL resolved to data without scalar values');
		}

		const renderOptions = loaded.request.renderOptions;
		const frame: Frame = {
			values,
			gridUniforms: computeGridUniforms(loaded.domain.grid, loaded.ranges),
			interpolation: renderOptions.interpolation,
			colorScale: renderOptions.colorScale,
			colorBlend: renderOptions.colorBlend,
			halfQuantum: computeHalfQuantum(loaded.data.scaleFactor)
		};

		return () => {
			if (sequence !== this.loadSequence) return;
			// New data cross-fades over what is on screen. Same data re-committed
			// (a restyle, or a viewport refresh after moveend) swaps in place and
			// simply adopts the frame's fresh render options.
			if (this.current && this.current.values !== frame.values) {
				this.outgoing = this.current;
				this.crossfadeStart = performance.now();
			}
			this.current = frame;
			this.map?.triggerRepaint();
		};
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
		this.rendererGl = gl;
		this.renderer = acquireSharedRenderer(gl, this.textureCacheMb);
	}

	onRemove(): void {
		if (this.rendererGl) {
			releaseSharedRenderer(this.rendererGl);
			this.rendererGl = undefined;
		}
		this.renderer = undefined;
		this.map = undefined;
	}

	render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput): void {
		if (!this.renderer || !this.map) return;

		// The map's own projectTile prelude renders mercator, globe and the
		// transition between them; the fragment shader is projection-agnostic.
		const projection: GpuDrawOptions['projection'] = {
			shaderData: args.shaderData,
			data: args.defaultProjectionData
		};

		// A URL change dissolves: the outgoing frame renders underneath on the
		// compensation curve b = p(1-e)/(1-p·e) while the new one fades in on
		// top, so the combined coverage stays at p throughout.
		let opacity = this.opacity;
		if (this.outgoing) {
			const t = Math.min(
				1,
				(performance.now() - this.crossfadeStart) / WeatherGpuLayer.CROSSFADE_MS
			);
			if (t >= 1) {
				this.outgoing = undefined;
			} else {
				const e = t * t * (3 - 2 * t);
				const p = this.opacity;
				const under = (p * (1 - e)) / Math.max(0.001, 1 - p * e);
				this.renderPlain(projection, this.outgoing, under);
				opacity = p * e;
				this.map.triggerRepaint();
			}
		}

		if (this.current) {
			this.renderPlain(projection, this.current, opacity);
		}
	}

	private renderPlain(
		projection: GpuDrawOptions['projection'],
		frame: Frame,
		opacity: number
	): void {
		const renderer = this.renderer!;
		const g = frame.gridUniforms;
		renderer.draw({
			projection,
			gridUniforms: g,
			valuesTexture: renderer.getValueTexture(frame.values, g.nx, g.ny),
			interpolation: frame.interpolation,
			lut: renderer.getLut(frame.colorScale, frame.colorBlend),
			halfQuantum: frame.halfQuantum,
			opacity,
			worldOffsets: this.worldOffsets(projection)
		});
	}

	/** World copies needed to cover the viewport across the antimeridian. */
	private worldOffsets(projection: GpuDrawOptions['projection']): number[] {
		// On the globe (and during the transition) x wraps around the sphere, so a
		// world copy would draw over the base world and double the blended alpha.
		if (projection.data.projectionTransition > 0) return [0];
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
