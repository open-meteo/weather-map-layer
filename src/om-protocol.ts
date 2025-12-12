import { type GetResourceResponse, type RequestParameters } from 'maplibre-gl';

import { defaultResolveRequest, parseRequest } from './utils/parse-request';
import { assertOmUrlValid, parseMetaJson } from './utils/parse-url';
import { COLOR_SCALES_WITH_ALIASES as defaultColorScales } from './utils/styling';

import { domainOptions as defaultDomainOptions } from './domains';
import { GridFactory } from './grids/index';
import { ensureData, getOrCreateState, getProtocolInstance } from './om-protocol-state';
import { capitalize } from './utils';
import { WorkerPool } from './worker-pool';

import type {
	Data,
	DataIdentityOptions,
	OmProtocolSettings,
	ParsedRequest,
	TileJSON,
	TilePromise
} from './types';

const workerPool = new WorkerPool();

export const defaultOmProtocolSettings: OmProtocolSettings = {
	// static
	useSAB: false,

	// dynamic
	colorScales: defaultColorScales,
	domainOptions: defaultDomainOptions,

	resolveRequest: defaultResolveRequest,
	postReadCallback: undefined
};

export const omProtocol = async (
	params: RequestParameters,
	abortController?: AbortController,
	settings = defaultOmProtocolSettings
): Promise<GetResourceResponse<TileJSON | ImageBitmap | ArrayBuffer>> => {
	const instance = getProtocolInstance(settings);

	const url = await resolveJSONUrl(params.url);
	const request = parseRequest(url, settings);

	const state = getOrCreateState(
		instance.stateByKey,
		request.stateKey,
		request.dataOptions,
		request.baseUrl
	);

	const data = await ensureData(state, instance.omFileReader, settings.postReadCallback);

	// Handle TileJSON request
	if (params.type == 'json') {
		return { data: await getTilejson(params.url, request.dataOptions) };
	}

	// Handle tile request
	if (params.type !== 'image' && params.type !== 'arrayBuffer') {
		throw new Error(`Unsupported request type '${params.type}'`);
	}

	if (!request.tileIndex) {
		throw new Error(`Tile coordinates required for ${params.type} request`);
	}

	const tile = await requestTile(request, data, params.type);

	return { data: tile };
};

const resolveJSONUrl = async (url: string): Promise<string> => {
	let normalized = url;
	if (normalized.includes('.json')) {
		normalized = await parseMetaJson(normalized);
	}
	assertOmUrlValid(normalized);
	return normalized;
};

const buildTileKey = (request: ParsedRequest): string => {
	const { baseUrl, tileIndex } = request;
	if (!tileIndex) {
		throw new Error('Cannot build tile key without tile index');
	}
	return `${baseUrl}/${tileIndex.z}/${tileIndex.x}/${tileIndex.y}`;
};

const requestTile = async (
	request: ParsedRequest,
	data: Data,
	type: 'image' | 'arrayBuffer'
): TilePromise => {
	if (!request.tileIndex) {
		throw new Error('Tile coordinates required for tile request');
	}

	const key = buildTileKey(request);

	return workerPool.requestTile({
		type: `get${capitalize(type)}` as 'getImage' | 'getArrayBuffer',
		key,
		tileIndex: request.tileIndex,
		data,
		dataOptions: request.dataOptions,
		renderOptions: request.renderOptions
	});
};

const getTilejson = async (
	fullUrl: string,
	dataOptions: DataIdentityOptions
): Promise<TileJSON> => {
	// We initialize the grid with the ranges set to null, because we want to find out the maximum bounds of this grid
	const grid = GridFactory.create(dataOptions.domain.grid, null);
	const bounds = grid.getBounds();

	return {
		tilejson: '2.2.0',
		tiles: [fullUrl + '/{z}/{x}/{y}'],
		attribution: '<a href="https://open-meteo.com">Open-Meteo</a>',
		minzoom: 0,
		maxzoom: 12,
		bounds: bounds
	};
};
