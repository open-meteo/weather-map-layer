import { boundsIncluded } from './utils/bounds';
import { normalizeLon } from './utils/math';
import { parseUrlComponents } from './utils/parse-url';

import { GridFactory } from './grids';
import { MapboxLayerFileReader } from './om-file-reader';

import type {
	Bounds,
	Data,
	DataIdentityOptions,
	DimensionRange,
	GridData,
	OmProtocolInstance,
	OmProtocolSettings,
	OmUrlState,
	PostReadCallback
} from './types';

interface InflightRequest {
	controller: AbortController;
	subscriberCount: number;
}

const inflightRequests = new WeakMap<OmUrlState, InflightRequest>();

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

export const getProtocolInstance = (settings: OmProtocolSettings): OmProtocolInstance => {
	if (omProtocolInstance) {
		// Warn if critical settings differ from initial configuration
		if (settings.fileReaderConfig.useSAB !== omProtocolInstance.omFileReader.config.useSAB) {
			throw new Error(
				'omProtocol: useSAB setting differs from initial configuration. ' +
					'The protocol instance is shared and uses the first settings provided.'
			);
		}
		return omProtocolInstance;
	}

	const instance = {
		omFileReader: new MapboxLayerFileReader(settings.fileReaderConfig),
		stateByKey: new Map()
	};
	omProtocolInstance = instance;
	return instance;
};

export const getRanges = (gridData: GridData, bounds: Bounds | undefined): DimensionRange[] => {
	if (bounds) {
		const gridGetter = GridFactory.create(gridData, null);
		return gridGetter.getCoveringRanges(bounds[1], bounds[0], bounds[3], bounds[2]);
	} else {
		return [
			{ start: 0, end: gridData.ny },
			{ start: 0, end: gridData.nx }
		];
	}
};

export const getOrCreateState = (
	stateByKey: Map<string, OmUrlState>,
	stateKey: string,
	dataOptions: DataIdentityOptions,
	omFileUrl: string
): OmUrlState => {
	const existingState = stateByKey.get(stateKey);
	if (existingState) {
		if (existingState.dataOptions.bounds && dataOptions.bounds) {
			if (boundsIncluded(dataOptions.bounds, existingState.dataOptions.bounds)) {
				touchState(stateByKey, stateKey, existingState);
				return existingState;
			}
		} else if (existingState.dataOptions.bounds === undefined && dataOptions.bounds === undefined) {
			touchState(stateByKey, stateKey, existingState);
			return existingState;
		}
		// else we need to create a new state
	}

	evictStaleStates(stateByKey, stateKey);

	const ranges = getRanges(dataOptions.domain.grid, dataOptions.bounds);
	const state: OmUrlState = {
		dataOptions,
		ranges,
		omFileUrl,
		data: null,
		dataPromise: null,
		lastAccess: Date.now()
	};

	stateByKey.set(stateKey, state);
	return state;
};

/**
 * Ensures that data for a given state is loaded.
 * Handles multiple concurrent requests for the same data by sharing a promise.
 * Correctly handles AbortSignals by tracking all active subscribers and
 * only cancelling the underlying fetch if all subscribers have aborted.
 */
export const ensureData = async (
	state: OmUrlState,
	omFileReader: MapboxLayerFileReader,
	postReadCallback: PostReadCallback,
	signal?: AbortSignal
): Promise<Data> => {
	if (state.data) return state.data;
	if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

	const inflight = inflightRequests.get(state);
	const subscriberCount = (inflight?.subscriberCount ?? 0) + 1;

	if (inflight) {
		inflight.subscriberCount = subscriberCount;
	}

	let finished = false;
	const cleanup = () => {
		if (finished) return;
		finished = true;

		const current = inflightRequests.get(state);
		if (!current) return;

		if (current.subscriberCount <= 1) {
			inflightRequests.delete(state);
			current.controller.abort();
		} else {
			current.subscriberCount -= 1;
		}
	};

	if (signal) {
		signal.addEventListener('abort', cleanup, { once: true });
	}

	try {
		if (state.dataPromise) {
			return await state.dataPromise;
		}

		const controller = new AbortController();
		inflightRequests.set(state, { controller, subscriberCount });

		state.dataPromise = (async () => {
			try {
				await omFileReader.setToOmFile(state.omFileUrl);

				const data = await omFileReader.readVariable(
					state.dataOptions.variable,
					state.ranges,
					controller.signal
				);

				if (postReadCallback) {
					postReadCallback(omFileReader, data, state);
				}

				state.data = data;
				return data;
			} finally {
				state.dataPromise = null;
				inflightRequests.delete(state);
			}
		})();

		return await state.dataPromise;
	} finally {
		if (signal) {
			signal.removeEventListener('abort', cleanup);
		}
		cleanup();
	}
};

export const getValueFromLatLong = (
	lat: number,
	lon: number,
	omUrl: string
): { value: number; direction?: number } => {
	if (!omProtocolInstance) {
		throw new Error('OmProtocolInstance is not initialized');
	}

	const { fileAndVariableKey } = parseUrlComponents(omUrl);
	const state = omProtocolInstance.stateByKey.get(fileAndVariableKey);
	if (!state) {
		throw new Error(`State not found for key: ${fileAndVariableKey}`);
	}

	state.lastAccess = Date.now();

	if (!state.data?.values) {
		return { value: NaN };
	}

	const grid = GridFactory.create(state.dataOptions.domain.grid, state.ranges);
	const lonNormalized = normalizeLon(lon);
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
