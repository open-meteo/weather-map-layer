/**
 * Seamless composite data access for the GPU layer.
 *
 * Mirrors the layer selection of the protocol's `resolveLayers` (minZoom
 * gate, viewport gate, maxForecastHours gate, seamless→concrete URL
 * substitution) but loads into per-layer entries the render loop can draw as
 * one multi-layer GPU pass. Data goes through the same protocol state as the
 * CPU path, so both share fetches and in-memory copies.
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
import { parseLeadTimeHours, replaceUrlDomain } from '../utils/parse-url';

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

export interface GpuSeamlessLayerData {
	domain: Domain;
	values: Float32Array;
	/** The full protocol data (incl. directions for wind) and its read ranges. */
	data: Data;
	ranges: DimensionRange[];
	/** Concrete URL-state key, labelling the texture for residency queries. */
	stateKey: string;
	scaleFactor?: number;
	gridUniforms: GpuGridUniforms;
	/** Origin of the uncropped grid, anchoring the downsampled contour blocks. */
	fullOrigin?: [number, number];
}

/** The sub-layers active for a zoom level (finest-first, minZoom gate). */
export const activeSeamlessLayers = (domain: SeamlessDomain, zoom: number): SeamlessLayer[] =>
	domain.layers.filter((layer) => layer.minZoom <= zoom);

/**
 * True when this (non-global) layer cannot contribute: outside the viewport or
 * past its forecast horizon. Mirrors the gates of `selectSeamlessLayers`.
 */
const isLayerGated = (
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
	signal?: AbortSignal,
	/** Require the exact current crop (see getOrCreateState) — used when
	 *  re-resolving the outgoing composite for a temporal morph. */
	exactCrop = false
): Promise<GpuSeamlessLayerData | null> => {
	const concreteDomain = resolveConcreteDomain(layerDef.domainValue, settings.domainOptions);
	if (!concreteDomain) {
		console.warn(`[seamless] Domain not found: ${layerDef.domainValue}`);
		return null;
	}

	const domainBounds = GridFactory.create(concreteDomain.grid, null).getBounds() as Bounds;
	// The same URL and state-key substitution as the protocol's `resolveLayers`,
	// so a sub-layer's state is shared with the CPU tiles for it.
	const concreteBaseUrl = replaceUrlDomain(
		request.baseUrl,
		seamlessDomain.value,
		concreteDomain.value
	);
	if (isLayerGated(layerDef, isGlobal, concreteBaseUrl, domainBounds, request.dataOptions.bounds)) {
		return null;
	}

	const concreteKey = replaceUrlDomain(
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
		Math.max(settings.maxStatesWithData ?? DEFAULT_MAX_STATES_WITH_DATA, activeLayerCount),
		exactCrop
	);

	try {
		const data = await ensureData(state, instance.omFileReader, settings.postReadCallback, signal);
		const values = data.values;
		if (!values) return null;

		const gridUniforms = computeGridUniforms(concreteDomain.grid, state.ranges);
		const fullUniforms =
			gridUniforms.gridKind === 'gaussian'
				? undefined
				: computeGridUniforms(concreteDomain.grid, null);
		return {
			domain: concreteDomain,
			values,
			data,
			ranges: state.ranges,
			stateKey: concreteKey,
			scaleFactor: data.scaleFactor,
			gridUniforms,
			fullOrigin: fullUniforms ? [fullUniforms.originX, fullUniforms.originY] : undefined
		};
	} catch {
		return null;
	}
};
