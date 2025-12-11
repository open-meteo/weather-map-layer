import { setupGlobalCache } from '@openmeteo/file-reader';

import { parseUrlComponents } from './utils/parse-url';

import { GridFactory } from './grids';
import { OMapsFileReader } from './om-file-reader';

import type {
	Data,
	DataIdentityOptions,
	OmProtocolInstance,
	OmProtocolSettings,
	OmUrlState,
	PostReadCallback
} from './types';

// Configuration constants - could be made configurable via OmProtocolSettings
/** Max states that keep data loaded.
 *
 * This should be as low as possible, but needs to be at least the number of
 * variables that you want to display simultaneously. */
const MAX_STATES_WITH_DATA = 2;
/** 1 minute for hard eviction on new data fetches */
const STALE_THRESHOLD_MS = 1 * 60 * 1000;

// THIS is shared global state. The protocol can be added only once with different settings!
let omProtocolInstance: OmProtocolInstance | undefined = undefined;
setupGlobalCache();

export const getProtocolInstance = (settings: OmProtocolSettings): OmProtocolInstance => {
	if (omProtocolInstance) {
		// Warn if critical settings differ from initial configuration
		if (settings.useSAB !== omProtocolInstance.omFileReader.config.useSAB) {
			throw new Error(
				'omProtocol: useSAB setting differs from initial configuration. ' +
					'The protocol instance is shared and uses the first settings provided.'
			);
		}
		return omProtocolInstance;
	}

	const instance = {
		omFileReader: new OMapsFileReader({ useSAB: settings.useSAB }),
		stateByKey: new Map()
	};
	omProtocolInstance = instance;
	return instance;
};

export const getOrCreateState = (
	stateByKey: Map<string, OmUrlState>,
	stateKey: string,
	dataOptions: DataIdentityOptions,
	omFileUrl: string
): OmUrlState => {
	const existingState = stateByKey.get(stateKey);
	if (existingState) {
		touchState(stateByKey, stateKey, existingState);
		return existingState;
	}

	evictStaleStates(stateByKey, stateKey);

	const state: OmUrlState = {
		dataOptions,
		omFileUrl,
		data: null,
		dataPromise: null,
		lastAccess: Date.now()
	};

	stateByKey.set(stateKey, state);
	return state;
};

export const ensureData = async (
	state: OmUrlState,
	omFileReader: OMapsFileReader,
	postReadCallback: PostReadCallback
): Promise<Data> => {
	if (state.data) return state.data;
	if (state.dataPromise) return state.dataPromise;

	const promise = (async () => {
		try {
			await omFileReader.setToOmFile(state.omFileUrl);
			const data = await omFileReader.readVariable(
				state.dataOptions.variable,
				state.dataOptions.ranges
			);

			if (postReadCallback) {
				postReadCallback(omFileReader, data, state);
			}

			state.data = data;
			state.dataPromise = null;

			return data;
		} catch (error) {
			state.dataPromise = null; // Clear promise so retry is possible
			throw error;
		}
	})();

	state.dataPromise = promise;
	return promise;
};

export const getValueFromLatLong = (
	lat: number,
	lon: number,
	omUrl: string
): { value: number; direction?: number } => {
	if (!omProtocolInstance) {
		throw new Error('OmProtocolInstance is not initialized');
	}

	const { stateKey } = parseUrlComponents(omUrl);
	const state = omProtocolInstance.stateByKey.get(stateKey);
	if (!state) {
		throw new Error(`State not found for key: ${stateKey}`);
	}

	state.lastAccess = Date.now();

	if (!state.data?.values) {
		return { value: NaN };
	}

	const grid = GridFactory.create(state.dataOptions.domain.grid, state.dataOptions.ranges);
	const lonNormalized = ((lon + 540) % 360) - 180;
	const value = grid.getLinearInterpolatedValue(state.data.values, lat, lonNormalized);

	return { value };
};

/**
 * Evicts old state entries.
 * Since Map maintains insertion order and we re-insert on access,
 * the oldest entries are always at the front - no sorting needed.
 */
const evictStaleStates = (stateByKey: Map<string, OmUrlState>, currentKey?: string): void => {
	const now = Date.now();

	// Iterate from oldest to newest (Map iteration order)
	for (const [key, state] of stateByKey) {
		// Stop if we're under the limit and remaining entries aren't stale
		if (stateByKey.size <= MAX_STATES_WITH_DATA) {
			const age = now - state.lastAccess;
			if (age <= STALE_THRESHOLD_MS) break; // Remaining entries are newer
		}

		if (key === currentKey) continue;

		const age = now - state.lastAccess;
		const isStale = age > STALE_THRESHOLD_MS;
		const exceedsMax = stateByKey.size > MAX_STATES_WITH_DATA;

		if (isStale || exceedsMax) {
			stateByKey.delete(key);
		} else {
			break; // All remaining entries are newer, stop iterating
		}
	}
};

/**
 * Moves an entry to the end of the map (most recently used position).
 * This maintains LRU order without sorting.
 */
const touchState = (stateByKey: Map<string, OmUrlState>, key: string, state: OmUrlState): void => {
	state.lastAccess = Date.now();
	// Delete and re-insert to move to end (most recent)
	stateByKey.delete(key);
	stateByKey.set(key, state);
};
