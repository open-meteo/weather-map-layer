import { type GetResourceResponse, type RequestParameters } from 'maplibre-gl';

import { constrainBounds } from './utils/bounds';
import { type ResolvedClippingOptions } from './utils/clipping';
import { defaultResolveRequest, parseRequest } from './utils/parse-request';
import { parseMetaJson } from './utils/parse-url';
import { COLOR_SCALES_WITH_ALIASES as defaultColorScales } from './utils/styling';

import { domainOptions as defaultDomainOptions } from './domains';
import { SummedAreaTable } from './grids/area-average';
import { GridFactory } from './grids/index';
import { defaultFileReaderConfig } from './om-file-reader';
import { ensureData, getOrCreateState, getProtocolInstance } from './om-protocol-state';
import { capitalize } from './utils';
import { WorkerPool } from './worker-pool';

import type {
	Data,
	DataIdentityOptions,
	OmProtocolSettings,
	OmUrlState,
	ParsedRequest,
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
): Promise<GetResourceResponse<TileJSON | TileResponse | null>> => {
	const signal = abortController.signal;

	// Check if already aborted
	if (signal.aborted) {
		return { data: null };
	}

	const instance = getProtocolInstance(settings);

	const url = await normalizeUrl(params.url);
	const request = parseRequest(url, settings);

	const state = getOrCreateState(
		instance.stateByKey,
		request.fileAndVariableKey,
		request.dataOptions,
		request.baseUrl
	);

	// Check abort status before proceeding
	if (signal.aborted) {
		return { data: null };
	}

	// Handle TileJSON request. The bounds only depend on the grid definition, so
	// respond immediately instead of blocking MapLibre's source setup on the full
	// data download. The data load is still kicked off right away (fire and
	// forget) so it runs while MapLibre processes the TileJSON — the subsequent
	// tile requests then await the same shared promise via state.dataPromise.
	if (params.type == 'json') {
		ensureData(state, instance.omFileReader, settings.postReadCallback).catch(() => {
			// Errors surface on the awaited tile requests; ignore here.
		});
		return {
			data: await getTilejson(params.url, request.dataOptions, request.clippingOptions)
		};
	}

	const data = await ensureData(state, instance.omFileReader, settings.postReadCallback, signal);

	// Handle tile request
	if (params.type !== 'image' && params.type !== 'arrayBuffer') {
		throw new Error(`Unsupported request type '${params.type}'`);
	}

	if (!request.tileIndex) {
		throw new Error(`Tile coordinates required for ${params.type} request`);
	}

	const tileResult = await requestTile(url, request, data, state, params.type, signal);

	if (tileResult.cancelled || !tileResult.data) {
		return { data: null };
	} else {
		return { data: tileResult.data };
	}
};

export const normalizeUrl = async (url: string): Promise<string> => {
	let normalized = url;
	if (url.includes('.json')) {
		normalized = await parseMetaJson(normalized);
	}
	return normalized;
};

const makeTileAbortedResponse = (): TileResult => {
	return { data: undefined, cancelled: true };
};
const makeEmptyVectorLayerResponse = (): TileResult => {
	return { data: new ArrayBuffer(0), cancelled: false };
};

const requestTile = async (
	url: string,
	request: ParsedRequest,
	data: Data,
	state: OmUrlState,
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
		if (
			!(request.renderOptions.drawArrows && data.directions !== undefined) &&
			!request.renderOptions.drawContours &&
			!request.renderOptions.drawGrid
		) {
			return makeEmptyVectorLayerResponse();
		}
	}

	const sat =
		request.renderOptions.interpolation === 'smooth'
			? await ensureSat(state, data, request)
			: undefined;

	return workerPool.requestTile({
		type: tileType,
		key,
		tileIndex: request.tileIndex,
		data,
		ranges: state.ranges,
		dataOptions: request.dataOptions,
		renderOptions: request.renderOptions,
		clippingOptions: request.clippingOptions,
		sat,
		signal
	});
};

// The 'smooth' method averages over a summed-area table that is identical for
// every tile of one data load. Build it once in a worker into
// SharedArrayBuffers and memoize it on the state, so tiles share the build
// zero-copy instead of each rebuilding an O(nx·ny) table. Resolves undefined
// when sharing is unavailable (no cross-origin isolation, ragged Gaussian
// grid, SSR) — workers then fall back to their per-tile lazy build.
const ensureSat = (
	state: OmUrlState,
	data: Data,
	request: ParsedRequest
): Promise<SummedAreaTable | undefined> => {
	if (state.satPromise) {
		return state.satPromise;
	}

	const ny = state.ranges[0].end - state.ranges[0].start;
	const nx = state.ranges[1].end - state.ranges[1].start;
	if (
		typeof SharedArrayBuffer === 'undefined' ||
		request.dataOptions.domain.grid.type === 'gaussian' ||
		!data.values ||
		data.values.length !== nx * ny
	) {
		state.satPromise = Promise.resolve(undefined);
		return state.satPromise;
	}

	state.satPromise = workerPool
		.buildSat(`sat:${request.fileAndVariableKey}`, data.values, nx, ny)
		.catch(() => undefined);
	return state.satPromise;
};

const getTilejson = async (
	fullUrl: string,
	dataOptions: DataIdentityOptions,
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

	return {
		tilejson: '3.0.0',
		tiles: [fullUrl + '/{z}/{x}/{y}'],
		attribution: '<a href="https://open-meteo.com/en/licence#maps">© Open-Meteo</a>',
		minzoom: 0,
		maxzoom: 12,
		bounds: bounds
	};
};
