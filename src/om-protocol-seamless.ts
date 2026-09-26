/**
 * Request handling for seamless composite domains: pick the active sub-domains,
 * load each one's data under its own concrete URL, and render the tile from all
 * of them, finest-first.
 */
import { type GetResourceResponse, type RequestParameters } from 'maplibre-gl';

import { parseLeadTimeHours, replaceUrlDomain } from './utils/parse-url';

import { getConcreteDomain, selectSeamlessLayers } from './domain-helpers';
import { DEFAULT_MAX_STATES_WITH_DATA, ensureData, getOrCreateState } from './om-protocol-state';
import { getTilejson, requestTile } from './om-protocol-tile';

import type {
	Domain,
	LayerRenderData,
	OmProtocolInstance,
	OmProtocolSettings,
	ParsedRequest,
	SeamlessDomain,
	TileJSON,
	TileResponse
} from './types';

export const handleSeamlessRequest = async (
	params: RequestParameters,
	url: string,
	request: ParsedRequest,
	seamlessDomain: SeamlessDomain,
	instance: OmProtocolInstance,
	settings: OmProtocolSettings,
	signal: AbortSignal
): Promise<GetResourceResponse<TileJSON | TileResponse | null>> => {
	if (signal.aborted) return { data: null };

	// TileJSON only needs the global layer's grid bounds, never any data.
	if (params.type === 'json') {
		const globalDomain = getConcreteDomain(seamlessDomain, settings.domainOptions);
		if (!globalDomain) return { data: null };
		return { data: await getTilejson(params.url, globalDomain, request.clippingOptions) };
	}

	if (params.type !== 'image' && params.type !== 'arrayBuffer') {
		throw new Error(`Unsupported request type '${params.type}'`);
	}

	if (!request.tileIndex) {
		throw new Error(`Tile coordinates required for ${params.type} request`);
	}

	// Layers past their forecast horizon are left out up front: the server has
	// no file for them and would answer 404 (which browsers surface as a CORS
	// error when the response omits Access-Control-Allow-Origin).
	const activeLayers = selectSeamlessLayers(seamlessDomain, settings.domainOptions, {
		zoom: request.tileIndex.z,
		viewportBounds: request.dataOptions.bounds,
		leadTimeHours: parseLeadTimeHours(request.baseUrl)
	});

	// All active layers load in parallel; a layer that fails is dropped so the
	// remaining ones still render. Reads are atomic per call, so concurrent
	// loads are safe. Each layer's data is cached in its state, so later tiles
	// for the same timestep return immediately.
	const loaded = await Promise.all(
		activeLayers.map(({ domain }) =>
			loadLayer(domain, request, seamlessDomain, activeLayers.length, instance, settings, signal)
		)
	);
	const layers = loaded.filter((layer): layer is LayerRenderData => layer !== null);
	if (layers.length === 0) return { data: null };

	// The finest layer is the tile's primary data; the worker samples through all
	// layers in order.
	const primary = layers[0];
	const primaryRequest: ParsedRequest<Domain> = {
		...request,
		dataOptions: { ...request.dataOptions, domain: primary.domain }
	};
	const tileResult = await requestTile(
		url,
		primaryRequest,
		primary.data,
		primary.ranges,
		params.type,
		signal,
		layers
	);

	if (tileResult.cancelled || !tileResult.data) {
		return { data: null };
	}
	return { data: tileResult.data };
};

/**
 * Loads one sub-domain's data for the request, or null when the load failed or
 * was aborted.
 */
const loadLayer = async (
	domain: Domain,
	request: ParsedRequest,
	seamlessDomain: SeamlessDomain,
	activeLayerCount: number,
	instance: OmProtocolInstance,
	settings: OmProtocolSettings,
	signal: AbortSignal
): Promise<LayerRenderData | null> => {
	if (signal.aborted) return null;

	// The server only knows the concrete domain, so the file is requested (and
	// its state keyed) under that domain's path.
	const baseUrl = replaceUrlDomain(request.baseUrl, seamlessDomain.value, domain.value);
	const key = replaceUrlDomain(request.fileAndVariableKey, seamlessDomain.value, domain.value);

	const state = getOrCreateState(
		instance.stateByKey,
		key,
		{ ...request.dataOptions, domain },
		baseUrl,
		// One composite costs a state per active layer, so the cap the caller
		// expressed in variables has to be multiplied by them. Left at the plain
		// cap, every tile request would evict the sub-layers the next one still
		// needs and re-read them.
		(settings.maxStatesWithData ?? DEFAULT_MAX_STATES_WITH_DATA) * activeLayerCount
	);

	try {
		// ensureData short-circuits on cached data, so postReadCallback fires once
		// per real sub-layer load (not per tile), exactly as on the plain path.
		const data = await ensureData(state, instance.omFileReader, settings.postReadCallback, signal);
		return { domain, data, ranges: state.ranges };
	} catch {
		return null;
	}
};
