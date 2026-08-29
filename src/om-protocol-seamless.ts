/**
 * Seamless domain protocol handler.
 *
 * Extracted from om-protocol.ts to keep the core protocol file clean.
 * Contains all logic specific to SeamlessDomain composite domains.
 */
import { type GetResourceResponse, type RequestParameters } from 'maplibre-gl';

import { boundsIntersect, constrainBounds } from './utils/bounds';

import { resolveConcreteDomain } from './domain-helpers';
import { GridFactory } from './grids/index';
import { ensureData, getOrCreateState } from './om-protocol-state';
import { capitalize } from './utils';
import { workerPool } from './worker-pool-instance';

import type {
	Bounds,
	Data,
	DataIdentityOptions,
	DimensionRange,
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

export { isSeamlessDomain } from './domain-helpers';

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
		const globalDomain = resolveConcreteDomain(lastLayer.domainValue, settings.domainOptions);
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

	// The global fallback (last layer) covers the whole world and must always be
	// loaded — it is the only layer guaranteed to produce a value everywhere — so
	// it is exempt from the viewport gate below.
	const globalLayer = seamlessDomain.layers[seamlessDomain.layers.length - 1];
	const viewportBounds = request.dataOptions.bounds;

	// Load data for every active layer in parallel — reads are atomic per call, so
	// concurrent loads are safe. Promise.all preserves the finest-first layer
	// order; gated or failed layers resolve to null and are filtered out. After
	// the first load the data is cached in state.data, so subsequent tile requests
	// for the same time-step return immediately.
	const layerResults = await Promise.all(
		activeLayers.map(async (layer): Promise<SeamlessLayerRenderData | null> => {
			if (signal.aborted) return null;

			const concreteDomain = resolveConcreteDomain(layer.domainValue, settings.domainOptions);

			if (!concreteDomain) {
				console.warn(`[seamless] Domain not found: ${layer.domainValue}`);
				return null;
			}

			// Full geographic bounds of this domain (not viewport-cropped) — needed both
			// for the viewport gate here and for the blend math passed to the worker.
			const fullGrid = GridFactory.create(concreteDomain.grid, null);
			const domainBounds = fullGrid.getBounds() as Bounds;

			// Viewport gate: a local (non-global) layer that does not even partially
			// overlap the current map viewport contributes nothing to any visible tile,
			// so skip loading and blending it entirely. This keeps composite domains that
			// stack many regional models (e.g. om_global_seamless) cheap: only the models
			// actually on screen are fetched and blended.
			if (
				layer !== globalLayer &&
				viewportBounds &&
				!boundsIntersect(domainBounds, viewportBounds)
			) {
				return null;
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
					return null;
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
				// Run the same postReadCallback the regular path uses. ensureData
				// short-circuits on state.data, so it fires once per real sub-layer load
				// (not per tile), letting consumers warm caches / transform values
				// (e.g. the pressure_msl unit fix) for seamless composites too.
				data = await ensureData(state, instance.omFileReader, settings.postReadCallback, signal);
			} catch {
				return null;
			}

			return {
				domain: concreteDomain,
				data,
				ranges: state.ranges,
				domainBounds,
				blendWidthDeg: layer.blendWidthDeg,
				// Only blending layers need a NaN-distance field. Key it by the data's
				// URL + ranges so the worker computes it once per timestep/viewport.
				nanFieldKey:
					layer.blendWidthDeg > 0
						? `${concreteKey}@${state.ranges.map((r) => `${r.start}-${r.end}`).join(',')}`
						: undefined
			};
		})
	);
	const seamlessLayers = layerResults.filter(
		(layer): layer is SeamlessLayerRenderData => layer !== null
	);

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
