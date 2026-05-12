import type { WeatherMapLayerFileReader } from '../om-file-reader';
import { ensureData, getOrCreateState, getRanges } from '../om-protocol-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
	Data,
	DataIdentityOptions,
	Domain,
	GridData,
	OmUrlState,
	RegularGridData
} from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReadCall = {
	variable: unknown;
	ranges: unknown;
	signal: AbortSignal | undefined;
	resolve: (v: Data | PromiseLike<Data>) => void;
	reject: (err?: unknown) => void;
	aborted: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush the microtask queue without relying on arbitrary timer durations. */
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

const makeDomain = (): Domain => ({
	value: 'd',
	label: 'd',
	grid: { type: 'regular', nx: 10, ny: 10, lonMin: 0, latMin: 0, dx: 1, dy: 1 },
	time_interval: 'hourly',
	model_interval: '3_hourly'
});

const makeDataOptions = (overrides: Partial<DataIdentityOptions> = {}): DataIdentityOptions => ({
	domain: makeDomain(),
	variable: 'temp',
	bounds: undefined,
	...overrides
});

const makeMockData = (size = 100): Data => ({
	values: new Float32Array(size),
	directions: undefined
});

// ---------------------------------------------------------------------------
// FakeReader
// ---------------------------------------------------------------------------

/**
 * Controllable test double for WeatherMapLayerFileReader.
 *
 * Each call to readVariable is recorded in `calls` and returns a Promise
 * that the test controls via resolveCall / rejectCall.
 */
class FakeReader {
	calls: ReadCall[] = [];

	// Must match the WeatherMapLayerFileReader interface used by ensureData
	async setToOmFile(_url?: string): Promise<void> {
		// intentional no-op
	}

	readVariable(variable: unknown, ranges: unknown, signal?: AbortSignal): Promise<Data> {
		return new Promise<Data>((resolve, reject) => {
			const call: ReadCall = { variable, ranges, signal, resolve, reject, aborted: false };
			this.calls.push(call);

			if (signal?.aborted) {
				call.aborted = true;
				reject(new DOMException('Aborted', 'AbortError'));
				return;
			}

			signal?.addEventListener(
				'abort',
				() => {
					call.aborted = true;
					reject(new DOMException('Aborted', 'AbortError'));
				},
				{ once: true }
			);
		});
	}

	resolveCall(index: number, value: Data): void {
		const call = this.calls[index];
		if (!call) throw new Error(`No call at index ${index}`);
		call.resolve(value);
	}

	rejectCall(index: number, err: unknown): void {
		const call = this.calls[index];
		if (!call) throw new Error(`No call at index ${index}`);
		call.reject(err);
	}

	get lastCall(): ReadCall {
		const call = this.calls.at(-1);
		if (!call) throw new Error('No calls recorded');
		return call;
	}
}

// ---------------------------------------------------------------------------
// Helpers to cast the fake safely
// ---------------------------------------------------------------------------

/** Cast only when FakeReader structurally satisfies the subset used by ensureData. */
const asReader = (r: FakeReader) => r as unknown as WeatherMapLayerFileReader;

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

const makeState = (
	stateByKey: Map<string, OmUrlState>,
	key: string,
	dataOptions = makeDataOptions()
): OmUrlState => getOrCreateState(stateByKey, key, dataOptions, 'https://example.com/file.om');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('ensureData – request deduplication', () => {
	it('issues only one underlying readVariable call for concurrent subscribers', async () => {
		const state = makeState(new Map(), 'dedup');
		const reader = new FakeReader();

		ensureData(state, asReader(reader), undefined);
		ensureData(state, asReader(reader), undefined);

		await flushMicrotasks();

		expect(reader.calls).toHaveLength(1);
	});
});

describe('ensureData – single-subscriber cancellation', () => {
	it('does not abort the underlying request when one of multiple subscribers cancels', async () => {
		const state = makeState(new Map(), 's1');
		const reader = new FakeReader();

		const ac1 = new AbortController();
		const ac2 = new AbortController();

		// Subscribe with two independent abort controllers
		const p1 = ensureData(state, asReader(reader), undefined, ac1.signal);
		const p2 = ensureData(state, asReader(reader), undefined, ac2.signal);

		await flushMicrotasks();

		expect(reader.calls).toHaveLength(1);
		expect(reader.calls[0].signal!.aborted).toBe(false);

		// Cancel only the first subscriber
		ac1.abort();

		// The underlying request must remain active
		expect(reader.calls[0].signal!.aborted).toBe(false);

		// Resolve the underlying read
		const mockData = makeMockData();
		reader.resolveCall(0, mockData);

		// Subscriber 2 receives the data
		await expect(p2).resolves.toBe(mockData);

		// Subscriber 1 aborted before the data arrived.
		// The current implementation still resolves aborted subscribers when
		// the underlying request succeeds (abort is best-effort, not guaranteed).
		await expect(p1).resolves.toBe(mockData);
	});
});

describe('ensureData – full cancellation', () => {
	it('aborts the underlying request only when all subscribers cancel', async () => {
		const state = makeState(new Map(), 's2');
		const reader = new FakeReader();

		const ac1 = new AbortController();
		const ac2 = new AbortController();

		const p1 = ensureData(state, asReader(reader), undefined, ac1.signal);
		const p2 = ensureData(state, asReader(reader), undefined, ac2.signal);

		await flushMicrotasks();

		expect(reader.calls).toHaveLength(1);

		// First cancellation — underlying still active
		ac1.abort();
		expect(reader.calls[0].signal!.aborted).toBe(false);

		// Second cancellation — all subscribers gone, underlying should abort
		ac2.abort();
		expect(reader.calls[0].signal!.aborted).toBe(true);

		await expect(p1).rejects.toThrow();
		await expect(p2).rejects.toThrow();

		// State must be cleaned up so a new request can be issued
		expect(state.dataPromise).toBeNull();
	});

	it('allows a new request after full cancellation', async () => {
		const state = makeState(new Map(), 's3');
		const reader = new FakeReader();

		const ac = new AbortController();
		const abandoned = ensureData(state, asReader(reader), undefined, ac.signal);

		await flushMicrotasks();
		ac.abort();
		await expect(abandoned).rejects.toThrow();

		// New subscriber — must trigger a fresh underlying call
		const p = ensureData(state, asReader(reader), undefined);

		await flushMicrotasks();

		expect(reader.calls).toHaveLength(2);

		const mockData = makeMockData(50);
		reader.resolveCall(1, mockData);

		await expect(p).resolves.toBe(mockData);
	});
});

describe('ensureData – already-aborted signal', () => {
	it('rejects immediately without issuing an underlying request', async () => {
		const state = makeState(new Map(), 's4');
		const reader = new FakeReader();

		const ac = new AbortController();
		ac.abort(); // abort before calling ensureData

		await expect(ensureData(state, asReader(reader), undefined, ac.signal)).rejects.toThrow(
			'Aborted'
		);

		expect(reader.calls).toHaveLength(0);
	});
});

describe('ensureData – data already cached', () => {
	it('returns cached data without issuing an underlying request', async () => {
		const state = makeState(new Map(), 's5');
		const cachedData = makeMockData();
		state.data = cachedData;

		const reader = new FakeReader();
		const result = await ensureData(state, asReader(reader), undefined);

		expect(result).toBe(cachedData);
		expect(reader.calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// getRanges
// ---------------------------------------------------------------------------

describe('getRanges', () => {
	const makeGrid = (overrides: Partial<RegularGridData> = {}): GridData => ({
		type: 'regular',
		nx: 360,
		ny: 180,
		lonMin: -180,
		latMin: -90,
		dx: 1,
		dy: 1,
		...overrides
	});

	it('returns full grid ranges when bounds is undefined', () => {
		const grid = makeGrid();
		const ranges = getRanges(grid, undefined);

		expect(ranges).toEqual([
			{ start: 0, end: 180 },
			{ start: 0, end: 360 }
		]);
	});

	it('returns subset ranges when bounds is provided', () => {
		const grid = makeGrid();
		const bounds = [10, 40, 20, 50] as [number, number, number, number];
		const ranges = getRanges(grid, bounds);

		// Ranges should be a subset of the full grid
		expect(ranges[0].start).toBeGreaterThan(0);
		expect(ranges[0].end).toBeLessThan(180);
		expect(ranges[1].start).toBeGreaterThan(0);
		expect(ranges[1].end).toBeLessThan(360);
	});

	it('clamps bounds that exceed grid extent', () => {
		const grid = makeGrid({ lonMin: 0, latMin: 0, nx: 100, ny: 50, dx: 1, dy: 1 });
		// Bounds go beyond the grid's extent
		const bounds = [-10, -10, 200, 100] as [number, number, number, number];

		// Should not throw — bounds are clamped to grid extent
		const ranges = getRanges(grid, bounds);

		expect(ranges[0].start).toBe(0);
		expect(ranges[1].start).toBe(0);
		expect(ranges[0].end).toBe(50);
		expect(ranges[1].end).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// getOrCreateState – eviction
// ---------------------------------------------------------------------------

describe('getOrCreateState – eviction', () => {
	it('evicts oldest states when exceeding MAX_STATES_WITH_DATA', () => {
		const stateByKey = new Map<string, OmUrlState>();

		// MAX_STATES_WITH_DATA = 2. When creating the 4th, the map has 3 entries
		// which exceeds the limit, so eviction removes the oldest.
		makeState(stateByKey, 'k1');
		makeState(stateByKey, 'k2');
		makeState(stateByKey, 'k3');
		// Now map has k1, k2, k3 (size=3). Creating k4 triggers eviction with size>2.
		makeState(stateByKey, 'k4');

		expect(stateByKey.has('k1')).toBe(false);
		expect(stateByKey.has('k4')).toBe(true);
	});

	it('reuses existing state when bounds are included', () => {
		const stateByKey = new Map<string, OmUrlState>();
		const dataOptions = makeDataOptions({ bounds: [-50, -50, 50, 50] });
		const state1 = getOrCreateState(stateByKey, 'k1', dataOptions, 'https://example.com/file.om');

		// Request with smaller bounds (included in existing state)
		const dataOptions2 = makeDataOptions({ bounds: [-30, -30, 30, 30] });
		const state2 = getOrCreateState(stateByKey, 'k1', dataOptions2, 'https://example.com/file.om');

		expect(state2).toBe(state1);
	});

	it('creates new state when bounds are not included', () => {
		const stateByKey = new Map<string, OmUrlState>();
		const dataOptions = makeDataOptions({ bounds: [0, 0, 10, 10] });
		const state1 = getOrCreateState(stateByKey, 'k1', dataOptions, 'https://example.com/file.om');

		// Request with larger/different bounds
		const dataOptions2 = makeDataOptions({ bounds: [-50, -50, 50, 50] });
		const state2 = getOrCreateState(stateByKey, 'k1', dataOptions2, 'https://example.com/file.om');

		expect(state2).not.toBe(state1);
	});
});
