/**
 * How `omProtocol` serves a seamless composite: which layers it reads and
 * under which paths, and how failures, aborts and cached states behave. The
 * layer selection rules themselves are covered by domain-helpers.test.ts.
 */
import { defaultOmProtocolSettings } from '../om-protocol';
import { updateCurrentBounds } from '../utils/bounds';
import { RequestParameters } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
	DimensionRange,
	Domain,
	OmProtocolSettings,
	SeamlessDomain,
	TileJSON
} from '../types';

// ─── Hoisted mutable state shared between mock factories ──────────────────────

const { mockReturnBuffer, mockReadVariableSpy, mockShouldFail, mockOnReadVariable, mockValueFor } =
	vi.hoisted(() => ({
		mockReturnBuffer: { value: new ArrayBuffer(16) },
		/** All URLs passed to readVariable() in call order. */
		mockReadVariableSpy: { calls: [] as string[] },
		/** Set of URL path substrings whose readVariable should throw. */
		mockShouldFail: { substrings: new Set<string>() },
		/** Optional hook called synchronously at the start of readVariable. */
		mockOnReadVariable: { fn: undefined as ((url: string) => void) | undefined },
		/** Optional per-URL fill value for the returned data (default 0). */
		mockValueFor: { fn: undefined as ((url: string) => number) | undefined }
	}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../om-file-reader', async () => {
	const actual = await vi.importActual('../om-file-reader');
	return {
		...actual,
		WeatherMapLayerFileReader: class {
			config: Record<string, unknown>;
			constructor(config: Record<string, unknown>) {
				this.config = config;
			}

			async readVariable(
				omUrl: string,
				_variable: string,
				ranges: DimensionRange[],
				signal?: AbortSignal
			): Promise<{ values: Float32Array; directions: undefined }> {
				mockReadVariableSpy.calls.push(omUrl);
				mockOnReadVariable.fn?.(omUrl);
				if (signal?.aborted) {
					throw new DOMException('Aborted', 'AbortError');
				}
				for (const sub of mockShouldFail.substrings) {
					if (omUrl.includes(sub)) {
						throw new Error(`Simulated failure for: ${sub}`);
					}
				}
				const totalValues = ranges?.reduce((acc, r) => acc * (r.end - r.start + 1), 1) ?? 0;
				const fill = mockValueFor.fn?.(omUrl) ?? 0;
				return { values: new Float32Array(totalValues).fill(fill), directions: undefined };
			}

			async warmFile(_omUrl: string): Promise<void> {}
		}
	};
});

vi.mock('../worker-pool', () => ({
	WorkerPool: class {
		requestTile = vi.fn(() => Promise.resolve(mockReturnBuffer.value));
	}
}));

// ─── Test helpers ─────────────────────────────────────────────────────────────

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	mockReturnBuffer.value = new ArrayBuffer(16);
	mockReadVariableSpy.calls = [];
	mockShouldFail.substrings.clear();
	mockOnReadVariable.fn = undefined;
	mockValueFor.fn = undefined;
	// A world-covering viewport, so the viewport gate leaves no layer out unless
	// a test narrows it on purpose.
	updateCurrentBounds([-180, -90, 180, 90]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** A regular-grid domain of `nx` × `ny` cells from (lonMin, latMin) in steps of dx/dy. */
const makeRegularDomain = (
	value: string,
	opts: {
		nx?: number;
		ny?: number;
		lonMin?: number;
		latMin?: number;
		dx?: number;
		dy?: number;
	} = {}
): Domain => ({
	value,
	label: `Test ${value}`,
	grid: {
		type: 'regular',
		nx: opts.nx ?? 10,
		ny: opts.ny ?? 10,
		lonMin: opts.lonMin ?? -10,
		latMin: opts.latMin ?? -10,
		dx: opts.dx ?? 2,
		dy: opts.dy ?? 2
	},
	time_interval: 'hourly',
	model_interval: '3_hourly'
});

/** Concrete domain trio mirroring the real DWD ICON seamless stack. */
const GLOBAL_DOMAIN = makeRegularDomain('test_global', {
	nx: 20,
	ny: 20,
	lonMin: -20,
	latMin: -20,
	dx: 2,
	dy: 2
});
const EU_DOMAIN = makeRegularDomain('test_eu', {
	nx: 10,
	ny: 10,
	lonMin: -5,
	latMin: -5,
	dx: 1,
	dy: 1
});
const D2_DOMAIN = makeRegularDomain('test_d2', {
	nx: 6,
	ny: 6,
	lonMin: -1,
	latMin: -1,
	dx: 0.4,
	dy: 0.4
});

const SEAMLESS: SeamlessDomain = {
	type: 'seamless',
	value: 'test_seamless',
	label: 'Test Seamless',
	grid: GLOBAL_DOMAIN.grid,
	time_interval: 'hourly',
	model_interval: '3_hourly',
	layers: [
		{ domainValue: 'test_d2', minZoom: 5, maxForecastHours: 6 },
		{ domainValue: 'test_eu', minZoom: 3 },
		{ domainValue: 'test_global', minZoom: 0 }
	]
};

const makeSettings = (overrides: Partial<OmProtocolSettings> = {}): OmProtocolSettings => ({
	...defaultOmProtocolSettings,
	domainOptions: [GLOBAL_DOMAIN, EU_DOMAIN, D2_DOMAIN, SEAMLESS],
	...overrides
});

/** A file of the composite's 00Z run, valid at `validTime`. */
const fileUrl = (validTime = '2025-01-01T0000') =>
	`https://example.com/data_spatial/test_seamless/2025/01/01/0000Z/${validTime}.om?variable=temperature`;

const jsonParams = (): RequestParameters => ({ url: `om://${fileUrl()}`, type: 'json' });

const tileParams = (z: number, validTime?: string): RequestParameters => ({
	url: `om://${fileUrl(validTime)}/${z}/0/0`,
	type: 'arrayBuffer'
});

/** The domain segment of a file URL: the one before the model-run path. */
const domainOf = (url: string) => url.match(/\/([^/]+)\/\d{4}\/\d{2}\/\d{2}\/\d{4}Z\//)?.[1];

/** The domain of every file read so far, in call order. */
const readDomains = () => mockReadVariableSpy.calls.map(domainOf);

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('SeamlessDomain – TileJSON', () => {
	it('answers from the composite grid without reading data or needing a concrete domain', async () => {
		const { omProtocol } = await import('../om-protocol');
		const settings = makeSettings({ domainOptions: [SEAMLESS] });
		const result = await omProtocol(jsonParams(), new AbortController(), settings);

		expect((result.data as TileJSON).bounds).toEqual([-20, -20, 20, 20]);
		expect(mockReadVariableSpy.calls).toHaveLength(0);
	});
});

describe('SeamlessDomain – layers', () => {
	it('reads every active layer under its own domain path, finest-first', async () => {
		const { omProtocol } = await import('../om-protocol');
		const result = await omProtocol(tileParams(5), new AbortController(), makeSettings());

		expect(result.data).toBeInstanceOf(ArrayBuffer);
		expect(readDomains()).toEqual(['test_d2', 'test_eu', 'test_global']);
		for (const url of mockReadVariableSpy.calls) {
			expect(url).toContain('/2025/01/01/0000Z/2025-01-01T0000.om');
		}
	});

	it('reads layers under their own path for URLs without a data_spatial prefix', async () => {
		const { omProtocol } = await import('../om-protocol');
		const params: RequestParameters = {
			url: 'om://https://example.com/test_seamless/2025/01/01/0000Z/2025-01-01T0000.om?variable=temperature/5/0/0',
			type: 'arrayBuffer'
		};
		await omProtocol(params, new AbortController(), makeSettings());

		expect(readDomains()).toEqual(['test_d2', 'test_eu', 'test_global']);
		expect(mockReadVariableSpy.calls[0]).toBe(
			'https://example.com/test_d2/2025/01/01/0000Z/2025-01-01T0000.om'
		);
	});

	it('leaves out layers above the zoom', async () => {
		const { omProtocol } = await import('../om-protocol');
		await omProtocol(tileParams(0), new AbortController(), makeSettings());

		expect(readDomains()).toEqual(['test_global']);
	});

	it('leaves out finer layers outside the viewport', async () => {
		// East of test_d2 (lon ≤ 1.4), inside test_eu (lon ≤ 5).
		updateCurrentBounds([3, 3, 5, 5]);
		const { omProtocol } = await import('../om-protocol');
		await omProtocol(tileParams(5), new AbortController(), makeSettings());

		expect(readDomains()).toEqual(['test_eu', 'test_global']);
	});

	it('leaves out layers past their forecast horizon', async () => {
		const { omProtocol } = await import('../om-protocol');
		// 12 h into the 00Z run, past the 6 h horizon of test_d2.
		await omProtocol(tileParams(5, '2025-01-01T1200'), new AbortController(), makeSettings());

		expect(readDomains()).toEqual(['test_eu', 'test_global']);
	});

	it('returns { data: null } when no layer domain is in settings', async () => {
		const { omProtocol } = await import('../om-protocol');
		const settings = makeSettings({ domainOptions: [SEAMLESS] });
		const result = await omProtocol(tileParams(5), new AbortController(), settings);

		expect(result.data).toBeNull();
		expect(mockReadVariableSpy.calls).toHaveLength(0);
	});
});

describe('SeamlessDomain – failures and aborts', () => {
	it('drops a failing layer and renders from the rest', async () => {
		mockShouldFail.substrings.add('/test_d2/');
		const { omProtocol } = await import('../om-protocol');
		const result = await omProtocol(tileParams(5), new AbortController(), makeSettings());

		expect(result.data).toBeInstanceOf(ArrayBuffer);
		expect(readDomains()).toEqual(['test_d2', 'test_eu', 'test_global']);
	});

	it('rejects when every layer fails, like a failed plain read', async () => {
		mockShouldFail.substrings.add('/test_');
		const { omProtocol } = await import('../om-protocol');

		await expect(omProtocol(tileParams(5), new AbortController(), makeSettings())).rejects.toThrow(
			'Simulated failure'
		);
	});

	it('stops reading further layers once the signal aborts', async () => {
		// The abort fires inside the first (d2) read; eu and global are never read.
		const ac = new AbortController();
		mockOnReadVariable.fn = () => ac.abort();
		const { omProtocol } = await import('../om-protocol');
		const result = await omProtocol(tileParams(5), ac, makeSettings());

		expect(readDomains()).toEqual(['test_d2']);
		expect(result.data).toBeNull();
	});
});

describe('SeamlessDomain – layer states', () => {
	it('reads each layer once across tiles and reports each read to postReadCallback', async () => {
		const postReadCallback = vi.fn();
		const settings = makeSettings({ postReadCallback });
		const { omProtocol } = await import('../om-protocol');
		await omProtocol(tileParams(5), new AbortController(), settings);
		await omProtocol(tileParams(5), new AbortController(), settings);

		expect(readDomains()).toEqual(['test_d2', 'test_eu', 'test_global']);
		const reported = postReadCallback.mock.calls.map(([, , state]) => domainOf(state.omFileUrl));
		expect(reported).toEqual(['test_d2', 'test_eu', 'test_global']);
	});
});

describe('SeamlessDomain – getValueFromLatLong', () => {
	it('samples the composite through its loaded sub-domain states', async () => {
		const { omProtocol } = await import('../om-protocol');
		const { getValueFromLatLong } = await import('../om-protocol-state');
		const settings = makeSettings();
		const params = tileParams(5);
		await omProtocol(params, new AbortController(), settings);

		// (0, 0) lies inside all three layers; the mock data is all zeros.
		const result = await getValueFromLatLong(0, 0, params.url);
		expect(result.value).toBe(0);
	});

	it('keeps the lookup to the layers active at the given zoom', async () => {
		const { omProtocol } = await import('../om-protocol');
		const { getValueFromLatLong } = await import('../om-protocol-state');
		// Each sub-domain's data is told apart by its value.
		mockValueFor.fn = (url) => ({ test_d2: 2, test_eu: 1 })[domainOf(url) ?? ''] ?? 0;
		const params = tileParams(5);
		await omProtocol(params, new AbortController(), makeSettings());

		// All three states are loaded; the zoom decides which take part, like it
		// does for the tiles, so a popup at a coarser zoom matches its pixels.
		expect((await getValueFromLatLong(0, 0, params.url)).value).toBe(2);
		expect((await getValueFromLatLong(0, 0, params.url, 5)).value).toBe(2);
		expect((await getValueFromLatLong(0, 0, params.url, 3)).value).toBe(1);
		expect((await getValueFromLatLong(0, 0, params.url, 0)).value).toBe(0);
	});

	it('throws when no sub-domain state exists for the composite', async () => {
		const { omProtocol } = await import('../om-protocol');
		const { getValueFromLatLong } = await import('../om-protocol-state');
		const settings = makeSettings();
		// TileJSON initializes the protocol instance without creating any state.
		await omProtocol(jsonParams(), new AbortController(), settings);

		await expect(getValueFromLatLong(0, 0, tileParams(5).url)).rejects.toThrow('State not found');
	});
});
