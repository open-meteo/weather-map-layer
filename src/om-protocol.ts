import { type GetResourceResponse, type RequestParameters } from 'maplibre-gl';

import { clipBounds } from './utils/math';
import { defaultResolveRequest, parseRequest } from './utils/parse-request';
import { parseMetaJson } from './utils/parse-url';
import { COLOR_SCALES_WITH_ALIASES as defaultColorScales } from './utils/styling';

import { domainOptions as defaultDomainOptions } from './domains';
import { GridFactory } from './grids/index';
import { defaultFileReaderConfig } from './om-file-reader';
import { ensureData, getOrCreateState, getProtocolInstance } from './om-protocol-state';
import { capitalize } from './utils';
import { WorkerPool } from './worker-pool';

import type {
	ClippingOptions,
	Data,
	DataIdentityOptions,
	DimensionRange,
	OmProtocolSettings,
	ParsedRequest,
	RenderOptions,
	TileJSON,
	TilePromise
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
	abortController?: AbortController,
	settings = defaultOmProtocolSettings
): Promise<GetResourceResponse<TileJSON | ImageBitmap | ArrayBuffer>> => {
	const instance = getProtocolInstance(settings);

	const url = await normalizeUrl(params.url);
	const request = parseRequest(url, settings);

	const state = getOrCreateState(
		instance.stateByKey,
		request.fileAndVariableKey,
		request.dataOptions,
		request.baseUrl
	);

	const data = await ensureData(state, instance.omFileReader, settings.postReadCallback);

	// Handle TileJSON request
	if (params.type == 'json') {
		return { data: await getTilejson(params.url, request.dataOptions, settings.clippingOptions) };
	}

	// Handle tile request
	if (params.type !== 'image' && params.type !== 'arrayBuffer') {
		throw new Error(`Unsupported request type '${params.type}'`);
	}

	if (!request.tileIndex) {
		throw new Error(`Tile coordinates required for ${params.type} request`);
	}

	const tile = await requestTile(url, request, data, state.ranges, params.type);

	return { data: tile };
};

const normalizeUrl = async (url: string): Promise<string> => {
	let normalized = url;
	if (url.includes('.json')) {
		normalized = await parseMetaJson(normalized);
	}
	return normalized;
};

const requestTile = async (
	url: string,
	request: ParsedRequest,
	data: Data,
	ranges: DimensionRange[],
	type: 'image' | 'arrayBuffer'
): TilePromise => {
	if (!request.tileIndex) {
		throw new Error('Tile coordinates required for tile request');
	}

	const key = `${type}:${url}`;
	const tileType = `get${capitalize(type)}` as 'getImage' | 'getArrayBuffer';

	// early return if the worker will not return a tile
	if (tileType === 'getArrayBuffer') {
		if (
			!drawsArrows(request.renderOptions, data) &&
			!request.renderOptions.drawContours &&
			!request.renderOptions.drawGrid
		) {
			return new ArrayBuffer(0);
		}
	}

	return workerPool.requestTile({
		type: tileType,
		key,
		tileIndex: request.tileIndex,
		data,
		ranges,
		dataOptions: request.dataOptions,
		renderOptions: request.renderOptions,
		clippingOptions: request.clippingOptions
	});
};

const getTilejson = async (
	fullUrl: string,
	dataOptions: DataIdentityOptions,
	clippingOptions?: ClippingOptions
): Promise<TileJSON> => {
	// We initialize the grid with the ranges set to null, because we want to find out the maximum bounds of this grid
	// Also parse ranges here
	const grid = GridFactory.create(dataOptions.domain.grid, null);
	let bounds;
	if (clippingOptions && clippingOptions.bounds) {
		bounds = clipBounds(grid.getBounds(), clippingOptions.bounds);
	} else {
		bounds = grid.getBounds();
	}

	return {
		tilejson: '2.2.0',
		tiles: [fullUrl + '/{z}/{x}/{y}'],
		attribution: '<a href="https://open-meteo.com/en/licence#maps">© Open-Meteo</a>',
		minzoom: 0,
		maxzoom: 12,
		bounds: bounds
	};
};

const drawsArrows = (renderOptions: RenderOptions, data: Data): boolean => {
	return renderOptions.drawArrows && data.directions !== undefined;
};
