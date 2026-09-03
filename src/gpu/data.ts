/**
 * Data access for the GPU paths. Deliberately reuses the om protocol's
 * URL grammar, state cache and file reader (om-protocol-state.ts), so a GPU
 * layer and the CPU tile protocol pointed at the same om:// URL share one
 * fetch and one in-memory copy of the variable data.
 */
import { isSeamlessDomain } from '../domain-helpers';
import { defaultOmProtocolSettings } from '../om-protocol';
import { ensureData, getOrCreateState, getProtocolInstance } from '../om-protocol-state';
import { parseRequest } from '../utils/parse-request';
import { normalizeUrl } from '../utils/parse-url';

import type { Data, DimensionRange, Domain, OmProtocolSettings, ParsedRequest } from '../types';

export interface LoadedOmData {
	/** The normalized (dated) om:// URL the data was loaded for. */
	url: string;
	request: ParsedRequest;
	domain: Domain;
	data: Data;
	ranges: DimensionRange[];
}

/** True when the GPU raster path can render this request. */
export const isGpuRenderable = (request: ParsedRequest): boolean => {
	// Polygon clipping renders via the in-shader mask (clip-mask.ts); no
	// remaining request feature needs the CPU fallback.
	void request;
	return true;
};

/**
 * Resolves an om:// URL (meta-JSON forms included) and loads the variable data
 * through the shared protocol state.
 */
export const loadOmUrl = async (
	omUrl: string,
	settings: OmProtocolSettings = defaultOmProtocolSettings,
	signal?: AbortSignal
): Promise<LoadedOmData> => {
	const url = await normalizeUrl(omUrl, settings.domainOptions);
	const request = parseRequest(url, settings);

	if (isSeamlessDomain(request.dataOptions.domain)) {
		// Seamless composites load per sub-layer; see seamless-data.ts.
		throw new Error('gpu: seamless domains load through loadSeamlessLayer');
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

	return {
		url,
		request,
		domain: request.dataOptions.domain as Domain,
		data,
		ranges: state.ranges
	};
};
