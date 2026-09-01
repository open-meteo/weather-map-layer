/**
 * Seamless composite data access for the GPU layer.
 *
 * Mirrors the layer selection of om-protocol-seamless.ts (minZoom gate,
 * viewport gate, maxForecastHours gate, seamless→concrete URL substitution)
 * but loads into per-layer entries the render loop can draw as one multi-layer
 * GPU pass. Data goes through the same protocol state as the CPU path, so both
 * share fetches and in-memory copies.
 */
import { resolveConcreteDomain } from '../domain-helpers';
import { GridFactory } from '../grids/index';
import {
	DEFAULT_MAX_STATES_WITH_DATA,
	ensureData,
	getOrCreateState,
	getProtocolInstance
} from '../om-protocol-state';
import { boundsIntersect } from '../utils/bounds';
import { computeNanDistanceField } from '../utils/nan-distance';

import { computeGridUniforms } from './grid-uniforms';
import type { GpuGridUniforms } from './grid-uniforms';

import type {
	Bounds,
	Data,
	DataIdentityOptions,
	DimensionRange,
	Domain,
	OmProtocolSettings,
	ParsedRequest,
	SeamlessDomain,
	SeamlessLayer
} from '../types';

/**
 * Parse the model-run → valid-time lead in hours from an OM file URL
 * (copy of om-protocol-seamless.ts parseLeadTimeHours).
 */
const parseLeadTimeHours = (url: string): number | undefined => {
	const m = url.match(
		/\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})Z\/(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})\.om/
	);
	if (!m) return undefined;
	const [, yr, mo, dy, rh, rm, date, vh, vm] = m;
	const modelRun = Date.UTC(+yr, +mo - 1, +dy, +rh, +rm);
	const validTime = Date.UTC(
		+date.slice(0, 4),
		+date.slice(5, 7) - 1,
		+date.slice(8, 10),
		+vh,
		+vm
	);
	return (validTime - modelRun) / (1000 * 60 * 60);
};

export interface GpuSeamlessLayerData {
	layerDef: SeamlessLayer;
	domain: Domain;
	values: Float32Array;
	/** The full protocol data (incl. directions for wind) and its read ranges. */
	data: Data;
	ranges: DimensionRange[];
	scaleFactor?: number;
	gridUniforms: GpuGridUniforms;
	blendWidthDeg: number;
	/** NaN-distance field on the layer grid, refining the blend edge. */
	nanField?: Float32Array;
	/** Full geographic bounds, for the render-time viewport gate. */
	domainBounds: Bounds;
}

// NaN-distance fields keyed per data array (stable per timestep/viewport).
const nanFieldCache = new WeakMap<Float32Array, Float32Array | null>();

const getNanField = (
	layerDef: SeamlessLayer,
	domain: Domain,
	values: Float32Array,
	gridUniforms: GpuGridUniforms
): Float32Array | undefined => {
	// Same condition as seamless-sampling.ts getNanField: only blending
	// regular-grid layers carry a field.
	if (layerDef.blendWidthDeg <= 0 || domain.grid.type !== 'regular') return undefined;
	const cached = nanFieldCache.get(values);
	if (cached !== undefined) return cached ?? undefined;
	const field = computeNanDistanceField(
		values,
		gridUniforms.nx,
		gridUniforms.ny,
		domain.grid.dx!,
		domain.grid.dy!
	);
	nanFieldCache.set(values, field ?? null);
	return field;
};

/** The sub-layers active for a zoom level (finest-first, minZoom gate). */
export const activeSeamlessLayers = (domain: SeamlessDomain, zoom: number): SeamlessLayer[] =>
	domain.layers.filter((layer) => layer.minZoom <= zoom);

/**
 * True when this (non-global) layer cannot contribute: outside the viewport or
 * past its forecast horizon. Mirrors the gates of handleSeamlessRequest.
 */
export const isLayerGated = (
	layerDef: SeamlessLayer,
	isGlobal: boolean,
	concreteBaseUrl: string,
	domainBounds: Bounds,
	viewportBounds: Bounds | undefined
): boolean => {
	if (isGlobal) return false;
	if (viewportBounds && !boundsIntersect(domainBounds, viewportBounds)) return true;
	if (layerDef.maxForecastHours !== undefined) {
		const leadTime = parseLeadTimeHours(concreteBaseUrl);
		if (leadTime !== undefined && leadTime > layerDef.maxForecastHours) return true;
	}
	return false;
};

/** Substitute the seamless domain path segment with a concrete sub-domain. */
export const substituteSeamlessDomain = (
	url: string,
	seamlessValue: string,
	concreteValue: string
): string => url.replace(`/data_spatial/${seamlessValue}/`, `/data_spatial/${concreteValue}/`);

/**
 * Loads one seamless sub-layer through the shared protocol state. Returns null
 * when the layer is gated, unresolvable or fails to load (the caller falls
 * through to the next coarser layer, like the CPU path).
 */
export const loadSeamlessLayer = async (
	request: ParsedRequest,
	seamlessDomain: SeamlessDomain,
	layerDef: SeamlessLayer,
	isGlobal: boolean,
	settings: OmProtocolSettings,
	activeLayerCount: number,
	signal?: AbortSignal
): Promise<GpuSeamlessLayerData | null> => {
	const concreteDomain = resolveConcreteDomain(layerDef.domainValue, settings.domainOptions);
	if (!concreteDomain) {
		console.warn(`[seamless] Domain not found: ${layerDef.domainValue}`);
		return null;
	}

	const domainBounds = GridFactory.create(concreteDomain.grid, null).getBounds() as Bounds;
	const concreteBaseUrl = substituteSeamlessDomain(
		request.baseUrl,
		seamlessDomain.value,
		concreteDomain.value
	);
	if (isLayerGated(layerDef, isGlobal, concreteBaseUrl, domainBounds, request.dataOptions.bounds)) {
		return null;
	}

	const concreteKey = substituteSeamlessDomain(
		request.fileAndVariableKey,
		seamlessDomain.value,
		concreteDomain.value
	);
	const concreteDataOptions: DataIdentityOptions = {
		domain: concreteDomain,
		variable: request.dataOptions.variable,
		bounds: request.dataOptions.bounds
	};

	const instance = getProtocolInstance(settings);

	// The cap must cover every sub-layer of this composite, or loading the
	// finest layers would evict the coarser ones within a single request.
	const state = getOrCreateState(
		instance.stateByKey,
		concreteKey,
		concreteDataOptions,
		concreteBaseUrl,
		Math.max(settings.maxStatesWithData ?? DEFAULT_MAX_STATES_WITH_DATA, activeLayerCount)
	);

	try {
		const data = await ensureData(state, instance.omFileReader, settings.postReadCallback, signal);
		const values = data.values;
		if (!values) return null;

		const gridUniforms = computeGridUniforms(concreteDomain.grid, state.ranges);
		return {
			layerDef,
			domain: concreteDomain,
			values,
			data,
			ranges: state.ranges,
			scaleFactor: data.scaleFactor,
			gridUniforms,
			blendWidthDeg: layerDef.blendWidthDeg,
			nanField: getNanField(layerDef, concreteDomain, values, gridUniforms),
			domainBounds
		};
	} catch {
		return null;
	}
};
