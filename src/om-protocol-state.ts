import { boundsIncluded, constrainBounds } from './utils/bounds';
import { DEFAULT_INTERPOLATION, VALID_INTERPOLATIONS } from './utils/constants';
import { normalizeLon } from './utils/math';
import { parseUrlComponents } from './utils/parse-url';

import { GridFactory } from './grids';
import { WeatherMapLayerFileReader } from './om-file-reader';
import { normalizeUrl } from './om-protocol';

import type {
	Bounds,
	Data,
	DataIdentityOptions,
	DimensionRange,
	GridData,
	InterpolationMethod,
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

/** Default max states that keep data loaded (see `OmProtocolSettings.maxStatesWithData`).
 *
 * This should be as low as possible, but needs to be at least the number of
 * variables that you want to display simultaneously. */
export const DEFAULT_MAX_STATES_WITH_DATA = 2;
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
		omFileReader: new WeatherMapLayerFileReader(settings.fileReaderConfig),
		stateByKey: new Map()
	};
	omProtocolInstance = instance;
	return instance;
};

export const clearBlockCache = async (): Promise<void> => {
	await omProtocolInstance?.omFileReader.cache.clear();
	omProtocolInstance?.stateByKey.clear();
};

/** Drop all memoized HTTP backends, so the next read re-fetches file metadata. */
export const clearBackends = (): void => {
	omProtocolInstance?.omFileReader.clearBackends();
};

export const getRanges = (gridData: GridData, bounds: Bounds | undefined): DimensionRange[] => {
	if (bounds) {
		const gridGetter = GridFactory.create(gridData, null);
		// Clamp to grid extent so padded snap bounds don't produce out-of-range indices
		const clampedBounds = constrainBounds(bounds, gridGetter.getBounds()) ?? bounds;
		return gridGetter.getCoveringRanges(
			clampedBounds[1],
			clampedBounds[0],
			clampedBounds[3],
			clampedBounds[2]
		);
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
	omFileUrl: string,
	maxStatesWithData: number = DEFAULT_MAX_STATES_WITH_DATA
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
	// Evict after inserting so the cap actually holds `maxStatesWithData`
	// data-bearing states (the new key itself is never evicted).
	evictStaleStates(stateByKey, stateKey, maxStatesWithData);
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
	omFileReader: WeatherMapLayerFileReader,
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

		state.lastError = undefined;
		state.dataPromise = (async () => {
			try {
				const data = await omFileReader.readVariable(
					state.omFileUrl,
					state.dataOptions.variable,
					state.ranges,
					controller.signal
				);

				if (postReadCallback) {
					postReadCallback(omFileReader, data, state);
				}

				state.data = data;
				return data;
			} catch (error) {
				// Recorded so getDataState can report 'error' — MapLibre counts
				// failed tiles as complete, so renderers cannot see this otherwise.
				// An abort is every subscriber cancelling (normal map navigation),
				// not a failed load, so it leaves no error behind.
				if (!(error instanceof Error && error.name === 'AbortError')) {
					state.lastError = error;
				}
				throw error;
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

export type OmDataState = 'loaded' | 'loading' | 'error' | 'missing';

/**
 * Synchronous data-availability check for an om url (with or without the
 * om:// prefix). Lets renderers await actual data instead of inferring it
 * from tile events: failed tiles count as complete in MapLibre, so a purely
 * tile-based check can show an empty frame.
 *
 * States are keyed by the normalized URL: meta-JSON URLs (`latest.json`,
 * `in-progress.json`) must be resolved to their dated `.om` form first (see
 * `normalizeUrl`), otherwise this always returns 'missing'.
 */
export const getDataState = (omUrl: string): OmDataState => {
	if (!omProtocolInstance) return 'missing';
	try {
		const url = omUrl.startsWith('om://') ? omUrl : 'om://' + omUrl;
		const { fileAndVariableKey } = parseUrlComponents(url);
		const state = omProtocolInstance.stateByKey.get(fileAndVariableKey);
		if (!state) return 'missing';
		if (state.data) return 'loaded';
		if (state.dataPromise) return 'loading';
		return state.lastError !== undefined ? 'error' : 'missing';
	} catch {
		return 'missing';
	}
};

export const getValueFromLatLong = async (
	lat: number,
	lon: number,
	omUrl: string
): Promise<{ value: number; direction?: number }> => {
	if (!omProtocolInstance) {
		throw new Error('OmProtocolInstance is not initialized');
	}

	const url = await normalizeUrl(omUrl);

	const { fileAndVariableKey, params } = parseUrlComponents(url);
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
	// Sample with the same interpolation the tiles are rendered with (encoded in
	// the URL) so the popup value matches the pixel under the cursor.
	const interpolation = resolveInterpolation(params.get('interpolation'));
	const value = grid.getInterpolatedValue(state.data.values, lat, lonNormalized, interpolation);

	// Derived variables (u/v components, speed+direction, wave height+direction)
	// carry a direction field. Sampled the same way the arrows are (circular on
	// the degrees), so a popup arrow points exactly like the arrow under it.
	const directions = state.data.directions;
	if (!directions) return { value };

	return {
		value,
		direction: grid.getLinearInterpolatedDirection(directions, lat, lonNormalized)
	};
};

/** Parse the `interpolation` URL param, falling back to the default on absent or invalid values. */
const resolveInterpolation = (value: string | null): InterpolationMethod => {
	if (value && VALID_INTERPOLATIONS.includes(value as InterpolationMethod)) {
		return value as InterpolationMethod;
	}
	return DEFAULT_INTERPOLATION;
};

/**
 * Evicts old state entries.
 * Since Map maintains insertion order and we re-insert on access,
 * the oldest entries are always at the front - no sorting needed.
 */
const evictStaleStates = (
	stateByKey: Map<string, OmUrlState>,
	currentKey: string | undefined,
	maxStatesWithData: number
): void => {
	const now = Date.now();

	// Iterate from oldest to newest (Map iteration order)
	for (const [key, state] of stateByKey) {
		// Stop if we're under the limit and remaining entries aren't stale
		if (stateByKey.size <= maxStatesWithData) {
			const age = now - state.lastAccess;
			if (age <= STALE_THRESHOLD_MS) break; // Remaining entries are newer
		}

		if (key === currentKey) continue;

		const age = now - state.lastAccess;
		const isStale = age > STALE_THRESHOLD_MS;
		const exceedsMax = stateByKey.size > maxStatesWithData;

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
