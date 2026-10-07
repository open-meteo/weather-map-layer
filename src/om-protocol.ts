import { type GetResourceResponse, type RequestParameters } from 'maplibre-gl';

import { constrainBounds } from './utils/bounds';
import { type ResolvedClippingOptions } from './utils/clipping';
import { defaultResolveRequest, parseRequest } from './utils/parse-request';
import { normalizeUrl, parseLeadTimeHours } from './utils/parse-url';
import { COLOR_SCALES_WITH_ALIASES as defaultColorScales } from './utils/styling';

import { domainOptions as defaultDomainOptions } from './domains';
import { GridFactory } from './grids/index';
import { MAX_TILE_ZOOM, domainMaxZoom } from './grids/max-zoom';
import { defaultFileReaderConfig } from './om-file-reader';
import {
	DEFAULT_MAX_STATES_WITH_DATA,
	ensureData,
	getOrCreateState,
	getProtocolInstance,
	resolveLayers
} from './om-protocol-state';
import { capitalize } from './utils';
import { WorkerPool } from './worker-pool';

import type {
	DataIdentityOptions,
	Domain,
	LayerRenderData,
	OmProtocolSettings,
	ParsedRequest,
	RenderOptions,
	TileJSON,
	TilePromise,
	TileResponse,
	TileResult
} from './types';

const workerPool = new WorkerPool();

export const defaultOmProtocolSettings: OmProtocolSettings = {
	// static
	fileReaderConfig: defaultFileReaderConfig,

	// dynamic
	clippingOptions: undefined,
	colorScales: defaultColorScales,
	domainOptions: defaultDomainOptions,

	resolveRequest: defaultResolveRequest,
	postReadCallback: undefined
};

export const omProtocol = async (
	params: RequestParameters,
	abortController: AbortController,
	settings = defaultOmProtocolSettings
): Promise<GetResourceResponse<TileJSON | TileResponse>> => {
	const signal = abortController.signal;

	// Check if already aborted
	if (signal.aborted) {
		return makeEmptyTileResponse(params.type);
	}

	const instance = getProtocolInstance(settings);

	const url = await normalizeUrl(params.url, settings.domainOptions);
	const request = parseRequest(url, settings);

	// Handle TileJSON request. The bounds only depend on the grid definition, so
	// respond without touching the data: the read starts with the first tile
	// request, which is only a frame away, and never for a source whose tiles
	// are never requested (hidden layer, out of view).
	if (params.type == 'json') {
		return {
			data: await getTilejson(
				params.url,
				request.dataOptions,
				request.renderOptions,
				settings.domainOptions,
				request.clippingOptions
			)
		};
	}

	// Handle tile request
	if (params.type !== 'image' && params.type !== 'arrayBuffer') {
		throw new Error(`Unsupported request type '${params.type}'`);
	}

	if (!request.tileIndex) {
		throw new Error(`Tile coordinates required for ${params.type} request`);
	}

	// The concrete domains the tile is rendered from, finest-first: for a
	// composite, the layers active at this zoom, viewport and lead time.
	const layers = resolveLayers(
		request.dataOptions.domain,
		request.baseUrl,
		request.fileAndVariableKey,
		settings.domainOptions,
		{
			zoom: request.tileIndex.z,
			viewportBounds: request.dataOptions.bounds,
			leadTimeHours: parseLeadTimeHours(request.baseUrl)
		}
	);
	if (layers.length === 0) {
		return makeEmptyTileResponse(params.type);
	}

	// `maxStatesWithData` counts states, but callers size it in variables (one
	// state per variable for a plain domain). A composite needs one state per
	// layer for a single variable, so the cap is scaled by the layer count;
	// otherwise a composite's tile requests would evict the sub-domain states
	// the next tile still needs.
	const maxStatesWithData =
		(settings.maxStatesWithData ?? DEFAULT_MAX_STATES_WITH_DATA) * layers.length;
	const states = layers.map((layer) =>
		getOrCreateState(
			instance.stateByKey,
			layer.stateKey,
			{ ...request.dataOptions, domain: layer.domain },
			layer.omFileUrl,
			maxStatesWithData
		)
	);

	// Check abort status before proceeding
	if (signal.aborted) {
		return makeEmptyTileResponse(params.type);
	}

	// All layers load in parallel. A layer that fails is dropped so the others
	// still render; when none loads, the failure propagates like any read error.
	const settled = await Promise.allSettled(
		states.map((state) =>
			ensureData(state, instance.omFileReader, settings.postReadCallback, signal)
		)
	);
	const loaded: LayerRenderData[] = [];
	settled.forEach((result, i) => {
		if (result.status === 'fulfilled') {
			loaded.push({
				domain: states[i].dataOptions.domain,
				data: result.value,
				ranges: states[i].ranges
			});
		}
	});
	if (loaded.length === 0) {
		throw (settled[0] as PromiseRejectedResult).reason;
	}

	const tileResult = await requestTile(url, request, loaded, params.type, signal);

	if (tileResult.cancelled || !tileResult.data) {
		return makeEmptyTileResponse(params.type);
	} else {
		return { data: tileResult.data };
	}
};

/**
 * Response for a request with nothing to draw: aborted, or no layer covering
 * the tile. Not `null`: MapLibre's protocol handler type excludes it since
 * 6.11, and releases before 6.8 leave a raster tile that receives it loading
 * forever. An empty buffer is an empty vector tile on every release and an
 * empty raster tile from 6.8 on, but older releases try to decode it as an
 * image and fail, so a raster tile gets a transparent bitmap, which every
 * release uploads as is. Allocated per call: MapLibre transfers vector
 * payloads to its worker, which detaches the buffer.
 */
const makeEmptyTileResponse = async (
	type: RequestParameters['type']
): Promise<GetResourceResponse<TileResponse>> => {
	if (type === 'image' && typeof createImageBitmap === 'function') {
		return { data: await createImageBitmap(new ImageData(1, 1)) };
	}
	return { data: new ArrayBuffer(0) };
};

const makeTileAbortedResponse = (): TileResult => {
	return { data: undefined, cancelled: true };
};
const makeEmptyVectorLayerResponse = (): TileResult => {
	return { data: new ArrayBuffer(0), cancelled: false };
};

/** Renders one tile in the worker pool from `layers`, finest-first. */
const requestTile = async (
	url: string,
	request: ParsedRequest,
	layers: LayerRenderData[],
	type: 'image' | 'arrayBuffer',
	signal?: AbortSignal
): TilePromise => {
	if (!request.tileIndex) {
		throw new Error('Tile coordinates required for tile request');
	}

	if (signal?.aborted) {
		return makeTileAbortedResponse();
	}

	const key = `${type}:${url}`;
	const tileType = `get${capitalize(type)}` as 'getImage' | 'getArrayBuffer';

	// early return if the worker will not return a tile
	if (tileType === 'getArrayBuffer') {
		const hasDirections = layers.some((layer) => layer.data.directions !== undefined);
		if (
			!(request.renderOptions.drawArrows && hasDirections) &&
			!request.renderOptions.drawContours &&
			!request.renderOptions.drawGrid
		) {
			return makeEmptyVectorLayerResponse();
		}
	}

	return workerPool.requestTile({
		type: tileType,
		key,
		layers,
		tileIndex: request.tileIndex,
		renderOptions: request.renderOptions,
		clippingOptions: request.clippingOptions,
		signal
	});
};

const getTilejson = async (
	fullUrl: string,
	dataOptions: DataIdentityOptions,
	renderOptions: RenderOptions,
	domainOptions: Domain[],
	clippingOptions?: ResolvedClippingOptions
): Promise<TileJSON> => {
	// We initialize the grid with the ranges set to null, because we want to find out the maximum bounds of this grid
	const grid = GridFactory.create(dataOptions.domain.grid, null);
	let bounds;
	if (clippingOptions && clippingOptions.bounds) {
		bounds = constrainBounds(grid.getBounds(), clippingOptions.bounds) ?? grid.getBounds();
	} else {
		bounds = grid.getBounds();
	}

	// Raster tiles stop changing once a pixel is finer than the grid, so the
	// client overzooms from there. Vector tiles keep their per-tile layout
	// (arrow lattice, contour sampling) at every zoom.
	const isVector = renderOptions.drawArrows || renderOptions.drawContours || renderOptions.drawGrid;
	const maxzoom = isVector ? MAX_TILE_ZOOM : domainMaxZoom(dataOptions.domain, domainOptions);

	return {
		tilejson: '3.0.0',
		tiles: [fullUrl + '/{z}/{x}/{y}'],
		attribution: '<a href="https://open-meteo.com/en/licence#maps">© Open-Meteo</a>',
		minzoom: 0,
		maxzoom,
		bounds: bounds
	};
};
