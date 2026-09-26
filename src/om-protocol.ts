import { type GetResourceResponse, type RequestParameters } from 'maplibre-gl';

import { defaultResolveRequest, parseRequest } from './utils/parse-request';
import { normalizeUrl } from './utils/parse-url';
import { COLOR_SCALES_WITH_ALIASES as defaultColorScales } from './utils/styling';

import { isSeamlessDomain } from './domain-helpers';
import { domainOptions as defaultDomainOptions } from './domains';
import { defaultFileReaderConfig } from './om-file-reader';
import { handleSeamlessRequest } from './om-protocol-seamless';
import { ensureData, getOrCreateState, getProtocolInstance } from './om-protocol-state';
import { getTilejson, requestTile } from './om-protocol-tile';

import type { Domain, OmProtocolSettings, ParsedRequest, TileJSON, TileResponse } from './types';

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

	const url = await normalizeUrl(params.url, settings.domainOptions);
	const request = parseRequest(url, settings);
	const domain = request.dataOptions.domain;

	// A seamless composite is resolved into its concrete sub-domains by its own
	// handler; everything below works on a single concrete domain.
	if (isSeamlessDomain(domain)) {
		return handleSeamlessRequest(params, url, request, domain, instance, settings, signal);
	}
	const concreteRequest: ParsedRequest<Domain> = {
		...request,
		dataOptions: { ...request.dataOptions, domain }
	};

	const state = getOrCreateState(
		instance.stateByKey,
		request.fileAndVariableKey,
		concreteRequest.dataOptions,
		request.baseUrl,
		settings.maxStatesWithData
	);

	// Check abort status before proceeding
	if (signal.aborted) {
		return { data: null };
	}

	// Handle TileJSON request. The bounds only depend on the grid definition, so
	// respond without touching the data: the read starts with the first tile
	// request, which is only a frame away, and never for a source whose tiles
	// are never requested (hidden layer, out of view).
	if (params.type == 'json') {
		return {
			data: await getTilejson(params.url, domain, request.clippingOptions)
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

	const tileResult = await requestTile(
		url,
		concreteRequest,
		data,
		state.ranges,
		params.type,
		signal
	);

	if (tileResult.cancelled || !tileResult.data) {
		return { data: null };
	} else {
		return { data: tileResult.data };
	}
};
