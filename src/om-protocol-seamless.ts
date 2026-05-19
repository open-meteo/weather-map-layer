/**
 * Seamless domain protocol handler.
 *
 * Extracted from om-protocol.ts to keep the core protocol file clean.
 * Contains all logic specific to SeamlessDomain composite domains.
 */
import { type GetResourceResponse, type RequestParameters } from 'maplibre-gl';

import { constrainBounds } from './utils/bounds';

import { GridFactory } from './grids/index';
import { ensureData, getOrCreateState } from './om-protocol-state';
import { capitalize } from './utils';
import { workerPool } from './worker-pool-instance';

import type {
	Bounds,
	Data,
	DataIdentityOptions,
	DimensionRange,
	Domain,
	OmProtocolInstance,
	OmProtocolSettings,
	ParsedRequest,
	SeamlessDomain,
	SeamlessLayerRenderData,
	TileJSON,
	TilePromise,
	TileResponse,
	TileResult
} from './types';

/** Returns true when `domain` is a SeamlessDomain (composite, zoom-adaptive). */
export const isSeamlessDomain = (domain: { value: string }): domain is SeamlessDomain =>
	'layers' in domain;

/**
 * Parse the model-run → valid-time lead in hours from an OM file URL.
 *
 * Expected URL segment: …/YYYY/MM/DD/HHmmZ/YYYY-MM-DDTHHmm.om
 * Returns `undefined` when the URL does not match that structure.
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

// ─── Tile response helpers ─────────────────────────────────────────────────────

const makeTileAbortedResponse = (): TileResult => ({ data: undefined, cancelled: true });
const makeEmptyVectorLayerResponse = (): TileResult => ({
	data: new ArrayBuffer(0),
	cancelled: false
});

/**
 * Like `requestTile` in om-protocol.ts but also passes `seamlessLayers` to the
 * worker so it can perform per-pixel blending across domain boundaries.
 */
const requestTileSeamless = async (
	url: string,
	request: ParsedRequest,
	primaryData: Data,
	primaryRanges: DimensionRange[],
	seamlessLayers: SeamlessLayerRenderData[],
	type: 'image' | 'arrayBuffer',
	signal?: AbortSignal
): TilePromise => {
	if (!request.tileIndex) {
		throw new Error('Tile coordinates required for seamless tile request');
	}

	if (signal?.aborted) {
		return makeTileAbortedResponse();
	}

	const key = `${type}:${url}`;
	const tileType = `get${capitalize(type)}` as 'getImage' | 'getArrayBuffer';

	if (tileType === 'getArrayBuffer') {
		if (
			!(request.renderOptions.drawArrows && primaryData.directions !== undefined) &&
			!request.renderOptions.drawContours &&
			!request.renderOptions.drawGrid
		) {
			return makeEmptyVectorLayerResponse();
		}
	}

	return workerPool.requestTile({
		type: tileType,
		key,
		tileIndex: request.tileIndex,
		// Primary layer data used as fallback for vector tile paths
		data: primaryData,
		ranges: primaryRanges,
		dataOptions: request.dataOptions,
		renderOptions: request.renderOptions,
		clippingOptions: request.clippingOptions,
		seamlessLayers,
		signal
	});
};

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Handles a request whose domain is a SeamlessDomain:
 *  - Picks which concrete layers are active for the current zoom level
 *  - Skips layers whose `maxForecastHours` is exceeded by the URL's lead time,
 *    silently falling back to coarser layers instead of issuing a 404 request
 *  - Loads each layer's data from its own URL (substituting the domain name)
 *  - For image tiles: passes all layer data to the worker for per-pixel blending
 *  - For TileJSON: returns the bounds of the global (last) layer immediately,
 *    without blocking on data loading
 */
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

	const z = request.tileIndex?.z ?? 0;

	// Layers are ordered finest-first; keep those whose minZoom <= current zoom
	const activeLayers = seamlessDomain.layers.filter((l) => l.minZoom <= z);

	if (activeLayers.length === 0) return { data: null };

	// TileJSON: return bounds from the global (last) layer immediately —
	// no data load needed; bounds are computable from the domain grid definition.
	if (params.type === 'json') {
		const lastLayer = activeLayers[activeLayers.length - 1];
		const globalDomain = settings.domainOptions.find(
			(d) => d.value === lastLayer.domainValue && !isSeamlessDomain(d)
		) as Domain | undefined;
		if (!globalDomain) return { data: null };

		const fullGrid = GridFactory.create(globalDomain.grid, null);
		let bounds: Bounds = fullGrid.getBounds() as Bounds;
		if (request.clippingOptions?.bounds) {
			bounds = constrainBounds(bounds, request.clippingOptions.bounds) ?? bounds;
		}
		return {
			data: {
				tilejson: '3.0.0' as const,
				tiles: [params.url + '/{z}/{x}/{y}'],
				attribution: '<a href="https://open-meteo.com/en/licence#maps">© Open-Meteo</a>',
				minzoom: 0,
				maxzoom: 12,
				bounds
			}
		};
	}

	if (params.type !== 'image' && params.type !== 'arrayBuffer') {
		throw new Error(`Unsupported request type '${params.type}'`);
	}

	if (!request.tileIndex) {
		throw new Error(`Tile coordinates required for ${params.type} request`);
	}

	// Load data for every active layer SEQUENTIALLY to avoid a race condition:
	// WeatherMapLayerFileReader.setToOmFile() is stateful (sets this.reader) and is not
	// safe to call concurrently on the same instance.  Sequential loading ensures each
	// setToOmFile / readVariable pair runs to completion before the next begins.
	// After the first load the data is cached in state.data, so subsequent tile
	// requests for the same time-step return immediately with no serialization cost.
	const seamlessLayers: SeamlessLayerRenderData[] = [];

	for (const layer of activeLayers) {
		if (signal.aborted) break;

		const concreteDomain = settings.domainOptions.find(
			(d) => d.value === layer.domainValue && !isSeamlessDomain(d)
		) as Domain | undefined;

		if (!concreteDomain) {
			console.warn(`[seamless] Domain not found: ${layer.domainValue}`);
			continue;
		}

		// Derive the concrete URL by substituting the seamless domain name
		const concreteBaseUrl = request.baseUrl.replace(
			`/data_spatial/${seamlessDomain.value}/`,
			`/data_spatial/${concreteDomain.value}/`
		);
		const concreteKey = request.fileAndVariableKey.replace(
			`/data_spatial/${seamlessDomain.value}/`,
			`/data_spatial/${concreteDomain.value}/`
		);

		// Guard against 404 network errors: if the domain advertises a maximum forecast
		// horizon and the requested timestep is beyond it, skip this layer entirely and
		// fall through to the next coarser layer.  This prevents the browser from issuing
		// a request that the server will reject with a 404 (which browsers log as a CORS
		// error when the 404 response omits Access-Control-Allow-Origin).
		if (layer.maxForecastHours !== undefined) {
			const leadTime = parseLeadTimeHours(concreteBaseUrl);
			if (leadTime !== undefined && leadTime > layer.maxForecastHours) {
				continue;
			}
		}

		const concreteDataOptions: DataIdentityOptions = {
			domain: concreteDomain,
			variable: request.dataOptions.variable,
			bounds: request.dataOptions.bounds
		};

		const state = getOrCreateState(
			instance.stateByKey,
			concreteKey,
			concreteDataOptions,
			concreteBaseUrl
		);

		let data: Data;
		try {
			// Intentionally pass undefined for postReadCallback:
			// 1. postReadCallback (in maps/) calls setToOmFile() fire-and-forget, which would
			//    race with the next sequential ensureData call on the shared omFileReader.
			// 2. postReadCallback uses selectedDomain (which is SeamlessDomain) to build
			//    prefetch URLs, but SeamlessDomain may not support that operation.
			// Prefetching for seamless sub-layers is skipped; the primary layer handles it.
			data = await ensureData(state, instance.omFileReader, undefined, signal);
		} catch {
			continue;
		}

		// Full geographic bounds of this domain (not viewport-cropped) for blend math
		const fullGrid = GridFactory.create(concreteDomain.grid, null);

		seamlessLayers.push({
			domain: concreteDomain,
			data,
			ranges: state.ranges,
			domainBounds: fullGrid.getBounds() as Bounds,
			blendWidthDeg: layer.blendWidthDeg
		});
	}

	if (seamlessLayers.length === 0) return { data: null };

	// Use the finest (first) layer as the primary data source for vector tiles
	const primaryLayer = seamlessLayers[0];
	const primaryRequest: ParsedRequest = {
		...request,
		dataOptions: { ...request.dataOptions, domain: primaryLayer.domain }
	};

	const tileResult = await requestTileSeamless(
		url,
		primaryRequest,
		primaryLayer.data,
		primaryLayer.ranges,
		seamlessLayers,
		params.type,
		signal
	);

	if (tileResult.cancelled || !tileResult.data) {
		return { data: null };
	}
	return { data: tileResult.data };
};
