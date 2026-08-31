/**
 * Path A protocol entry: a drop-in `om://` protocol handler whose raster tiles
 * are rendered on the GPU instead of by the CPU worker pool.
 *
 * Everything around the pixels is reused unchanged — URL grammar, TileJSON,
 * data loading/state, vector (arrayBuffer) tiles — by delegating any request
 * the GPU path does not cover to the original `omProtocol`:
 *   - TileJSON requests (identical behaviour)
 *   - vector tiles (contours/arrows/grid stay on the CPU workers)
 *   - seamless composite domains, gaussian grids, polygon clipping
 *   - environments without WebGL2
 *
 * Register with: `maplibregl.addProtocol('om', omProtocolGpu)`.
 */
import { isSeamlessDomain } from '../domain-helpers';
import { defaultOmProtocolSettings, omProtocol } from '../om-protocol';
import { ensureData, getOrCreateState, getProtocolInstance } from '../om-protocol-state';
import { parseRequest } from '../utils/parse-request';
import { normalizeUrl } from '../utils/parse-url';
import type { GetResourceResponse, RequestParameters } from 'maplibre-gl';

import { isGpuRenderable } from './data';
import { isGpuSupported } from './renderer';
import { getSharedTileRenderer } from './tile-renderer';

import type { Domain, TileJSON, TileResponse } from '../types';

let gpuSupport: boolean | undefined;

export const omProtocolGpu = async (
	params: RequestParameters,
	abortController: AbortController,
	settings = defaultOmProtocolSettings
): Promise<GetResourceResponse<TileJSON | TileResponse | null>> => {
	const signal = abortController.signal;
	if (signal.aborted) {
		return { data: null };
	}

	gpuSupport ??= isGpuSupported();

	// Everything that is not a GPU-renderable raster tile goes down the
	// unchanged CPU path.
	if (!gpuSupport || params.type !== 'image') {
		return omProtocol(params, abortController, settings);
	}

	const url = await normalizeUrl(params.url, settings.domainOptions);
	const request = parseRequest(url, settings);
	// Path A renders plain domains only; seamless composites stay on the CPU
	// tile pipeline (the custom layer renders them on the GPU in one pass).
	if (!isGpuRenderable(request) || isSeamlessDomain(request.dataOptions.domain)) {
		return omProtocol(params, abortController, settings);
	}
	if (!request.tileIndex) {
		throw new Error('Tile coordinates required for image request');
	}

	const instance = getProtocolInstance(settings);
	const state = getOrCreateState(
		instance.stateByKey,
		request.fileAndVariableKey,
		request.dataOptions,
		request.baseUrl,
		settings.maxStatesWithData
	);

	const data = await ensureData(state, instance.omFileReader, settings.postReadCallback, signal);
	if (signal.aborted) {
		return { data: null };
	}

	const bitmap = getSharedTileRenderer().renderTile({
		tileIndex: request.tileIndex,
		data,
		ranges: state.ranges,
		domain: request.dataOptions.domain as Domain,
		renderOptions: request.renderOptions,
		clippingOptions: request.clippingOptions
	});

	return { data: bitmap };
};
