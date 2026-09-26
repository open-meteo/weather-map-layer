/**
 * The tile pipeline shared by plain and seamless requests: TileJSON for a
 * concrete domain, and handing a tile off to the worker pool.
 */
import { constrainBounds } from './utils/bounds';
import { type ResolvedClippingOptions } from './utils/clipping';

import { GridFactory } from './grids/index';
import { capitalize } from './utils';
import { workerPool } from './worker-pool-instance';

import type {
	Data,
	DimensionRange,
	Domain,
	LayerRenderData,
	ParsedRequest,
	TileJSON,
	TilePromise,
	TileResult
} from './types';

const makeTileAbortedResponse = (): TileResult => {
	return { data: undefined, cancelled: true };
};
const makeEmptyVectorLayerResponse = (): TileResult => {
	return { data: new ArrayBuffer(0), cancelled: false };
};

/**
 * Renders one tile in the worker pool from `data`/`ranges` of the request's
 * concrete domain. A seamless request also passes its active sub-domain layers,
 * finest-first; `request`, `data` and `ranges` then describe the finest one.
 */
export const requestTile = async (
	url: string,
	request: ParsedRequest<Domain>,
	data: Data,
	ranges: DimensionRange[],
	type: 'image' | 'arrayBuffer',
	signal?: AbortSignal,
	seamlessLayers?: LayerRenderData[]
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

	return workerPool.requestTile({
		type: tileType,
		key,
		tileIndex: request.tileIndex,
		data,
		ranges,
		dataOptions: request.dataOptions,
		renderOptions: request.renderOptions,
		clippingOptions: request.clippingOptions,
		seamlessLayers,
		signal
	});
};

export const getTilejson = async (
	fullUrl: string,
	domain: Domain,
	clippingOptions?: ResolvedClippingOptions
): Promise<TileJSON> => {
	// We initialize the grid with the ranges set to null, because we want to find out the maximum bounds of this grid
	const grid = GridFactory.create(domain.grid, null);
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
