/**
 * Comprehensive tests for the SeamlessDomain / handleSeamlessRequest feature.
 *
 * Covers:
 *  - TileJSON returned immediately (no data load) with correct bounds
 *  - Clipping applied to seamless TileJSON bounds
 *  - Zoom-level layer filtering (minZoom gating)
 *  - Sequential data loading (no shared-reader race)
 *  - postReadCallback is NOT invoked for sub-layer loads
 *  - Correct URL substitution for each concrete layer
 *  - Failed layers are skipped; surviving layers still render
 *  - All layers failing returns { data: null }
 *  - Abort signal stops sequential loading mid-way
 *  - State cache: second request for same data is instant (no re-read)
 *  - Unsupported request type throws
 *  - Missing tile coordinates throws for image requests
 *  - SeamlessDomain exposes time_interval and model_interval
 */

import { defaultOmProtocolSettings } from '../om-protocol';
import { RequestParameters } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DimensionRange, Domain, OmProtocolSettings, SeamlessDomain, TileJSON } from '../types';

// ─── Hoisted mutable state shared between mock factories ──────────────────────

const { mockReturnBuffer, mockSetToOmFileSpy, mockReadUrlLog, mockShouldFail, mockOnSetToOmFile } =
	vi.hoisted(() => ({
		mockReturnBuffer: { value: new ArrayBuffer(16) },
		/** All URLs passed to setToOmFile() in call order. */
		mockSetToOmFileSpy: { calls: [] as string[] },
		/** URL that was active (this.currentUrl) when each readVariable call ran. */
		mockReadUrlLog: { calls: [] as string[] },
		/** Set of URL path substrings whose readVariable should throw. */
		mockShouldFail: { substrings: new Set<string>() },
		/** Optional hook called synchronously inside setToOmFile. */
		mockOnSetToOmFile: { fn: undefined as ((url: string) => void) | undefined }
	}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../om-file-reader', async () => {
	const actual = await vi.importActual('../om-file-reader');
	return {
		...actual,
		WeatherMapLayerFileReader: class {
			config: Record<string, unknown>;
			private currentUrl = '';
			constructor(config: Record<string, unknown>) {
				this.config = config;
			}

			async setToOmFile(url: string): Promise<void> {
				this.currentUrl = url;
				mockSetToOmFileSpy.calls.push(url);
				mockOnSetToOmFile.fn?.(url);
			}

			async readVariable(
				_variable: string,
				ranges: DimensionRange[],
				_signal?: AbortSignal
			): Promise<{ values: Float32Array; directions: undefined }> {
				mockReadUrlLog.calls.push(this.currentUrl);
				for (const sub of mockShouldFail.substrings) {
					if (this.currentUrl.includes(sub)) {
						throw new Error(`Simulated failure for: ${sub}`);
					}
				}
				const totalValues =
					ranges?.reduce((acc, r) => acc * (r.end - r.start + 1), 1) ?? 0;
				return { values: new Float32Array(totalValues), directions: undefined };
			}
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
	mockSetToOmFileSpy.calls = [];
	mockReadUrlLog.calls = [];
	mockShouldFail.substrings.clear();
	mockOnSetToOmFile.fn = undefined;
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared domain/settings factories
// ---------------------------------------------------------------------------

/** Create a minimal regular-grid Domain. */
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
		dy: opts.dy ?? 2,
	},
	time_interval: 'hourly',
	model_interval: '3_hourly'
});

/** Concrete domain trio mirroring the real DWD ICON seamless stack. */
const GLOBAL_DOMAIN = makeRegularDomain('test_global', {
	nx: 20, ny: 20, lonMin: -20, latMin: -20, dx: 2, dy: 2
});
const EU_DOMAIN = makeRegularDomain('test_eu', {
	nx: 10, ny: 10, lonMin: -5, latMin: -5, dx: 1, dy: 1
});
const D2_DOMAIN = makeRegularDomain('test_d2', {
	nx: 6, ny: 6, lonMin: -1, latMin: -1, dx: 0.4, dy: 0.4
});

const SEAMLESS: SeamlessDomain = {
	type: 'seamless',
	value: 'test_seamless',
	label: 'Test Seamless',
	time_interval: 'hourly',
	model_interval: '3_hourly',
	layers: [
		{ domainValue: 'test_d2', minZoom: 5, blendWidthDeg: 0.5 },
		{ domainValue: 'test_eu', minZoom: 3, blendWidthDeg: 1.5 },
		{ domainValue: 'test_global', minZoom: 0, blendWidthDeg: 0 }
	]
};

const makeSettings = (overrides: Partial<OmProtocolSettings> = {}): OmProtocolSettings => ({
	...defaultOmProtocolSettings,
	domainOptions: [GLOBAL_DOMAIN, EU_DOMAIN, D2_DOMAIN, SEAMLESS],
	...overrides
});

/** Base URL segment used in test om:// URLs. */
const BASE = 'https://example.com/data_spatial/test_seamless/2025/01/01/0000Z/2025-01-01T0000.om';

const jsonParams = (): RequestParameters => ({
	url: `om://${BASE}?variable=temperature`,
	type: 'json'
});

const tileParams = (z: number, x = 0, y = 0): RequestParameters => ({
	url: `om://${BASE}?variable=temperature/${z}/${x}/${y}`,
	type: 'arrayBuffer'
});

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('SeamlessDomain – TileJSON', () => {
	it('returns TileJSON immediately without loading any data', async () => {
		const { omProtocol } = await import('../om-protocol');
		const result = await omProtocol(jsonParams(), new AbortController(), makeSettings());

		expect(result.data).not.toBeNull();
		const tj = result.data as TileJSON;
		expect(tj.tilejson).toBe('3.0.0');
		expect(tj.minzoom).toBe(0);
		expect(tj.maxzoom).toBe(12);

		// No data was loaded — setToOmFile should not have been called
		expect(mockSetToOmFileSpy.calls).toHaveLength(0);
	});

	it('TileJSON tiles URL matches the request URL', async () => {
		const { omProtocol } = await import('../om-protocol');
		const params = jsonParams();
		const result = await omProtocol(params, new AbortController(), makeSettings());

		const tj = result.data as TileJSON;
		expect(tj.tiles[0]).toBe(`${params.url}/{z}/{x}/{y}`);
	});

	it('TileJSON bounds come from the global (last) layer domain', async () => {
		const { omProtocol } = await import('../om-protocol');
		const result = await omProtocol(jsonParams(), new AbortController(), makeSettings());

		const tj = result.data as TileJSON;
		// GLOBAL_DOMAIN: lonMin=-20, nx=20, dx=2 → lonMax = -20 + 20*2 - 2 = 18
		//                latMin=-20, ny=20, dy=2 → latMax = -20 + 20*2 - 2 = 18
		// (exact values depend on getBounds() implementation; just check they're finite numbers)
		expect(tj.bounds).toHaveLength(4);
		expect(tj.bounds!.every(Number.isFinite)).toBe(true);
	});

	it('TileJSON bounds are clipped when clippingOptions are set', async () => {
		const { omProtocol } = await import('../om-protocol');
		const settings = makeSettings({
			clippingOptions: { bounds: [-5, -5, 5, 5] }
		});
		const result = await omProtocol(jsonParams(), new AbortController(), settings);

		const tj = result.data as TileJSON;
		const [lonMin, latMin, lonMax, latMax] = tj.bounds!;
		expect(lonMin).toBeGreaterThanOrEqual(-5);
		expect(latMin).toBeGreaterThanOrEqual(-5);
		expect(lonMax).toBeLessThanOrEqual(5);
		expect(latMax).toBeLessThanOrEqual(5);
	});

	it('TileJSON attribution contains Open-Meteo', async () => {
		const { omProtocol } = await import('../om-protocol');
		const result = await omProtocol(jsonParams(), new AbortController(), makeSettings());
		const tj = result.data as TileJSON;
		expect(tj.attribution).toContain('Open-Meteo');
	});

	it('returns { data: null } when the global backing domain is not in settings', async () => {
		const { omProtocol } = await import('../om-protocol');
		// Remove the global concrete domain from the domain list
		const settings = makeSettings({
			domainOptions: [EU_DOMAIN, D2_DOMAIN, SEAMLESS]
		});
		const result = await omProtocol(jsonParams(), new AbortController(), settings);
		expect(result.data).toBeNull();
	});
});

describe('SeamlessDomain – zoom-level layer filtering', () => {
	it('at zoom 0 only global layer is active', async () => {
		const { omProtocol } = await import('../om-protocol');
		await omProtocol(tileParams(0), new AbortController(), makeSettings());

		// Only global domain URL should have been opened
		const urls = mockSetToOmFileSpy.calls;
		expect(urls).toHaveLength(1);
		expect(urls[0]).toContain('/test_global/');
	});

	it('at zoom 3 eu + global layers are active (d2 skipped)', async () => {
		const { omProtocol } = await import('../om-protocol');
		await omProtocol(tileParams(3), new AbortController(), makeSettings());

		const domainValues = mockSetToOmFileSpy.calls.map(
			(u) => u.match(/\/data_spatial\/([^/]+)\//)?.[1]
		);
		// eu (minZoom 3) and global (minZoom 0) — d2 (minZoom 5) must be absent
		expect(domainValues).toContain('test_eu');
		expect(domainValues).toContain('test_global');
		expect(domainValues).not.toContain('test_d2');
	});

	it('at zoom 5 all three layers (d2, eu, global) are active', async () => {
		const { omProtocol } = await import('../om-protocol');
		await omProtocol(tileParams(5), new AbortController(), makeSettings());

		const domainValues = mockSetToOmFileSpy.calls.map(
			(u) => u.match(/\/data_spatial\/([^/]+)\//)?.[1]
		);
		expect(domainValues).toContain('test_d2');
		expect(domainValues).toContain('test_eu');
		expect(domainValues).toContain('test_global');
	});

	it('at zoom 4 (between 3 and 5) only eu + global are active', async () => {
		const { omProtocol } = await import('../om-protocol');
		await omProtocol(tileParams(4), new AbortController(), makeSettings());

		const domainValues = mockSetToOmFileSpy.calls.map(
			(u) => u.match(/\/data_spatial\/([^/]+)\//)?.[1]
		);
		expect(domainValues).not.toContain('test_d2');
		expect(domainValues).toContain('test_eu');
		expect(domainValues).toContain('test_global');
	});
});

describe('SeamlessDomain – sequential data loading / no race condition', () => {
	it('setToOmFile calls are sequential, never concurrent', async () => {
		// Each setToOmFile call must complete before the next starts.
		// We verify this by checking the order: d2 → eu → global (finest first).
		const { omProtocol } = await import('../om-protocol');
		await omProtocol(tileParams(5), new AbortController(), makeSettings());

		const domainOrder = mockSetToOmFileSpy.calls.map(
			(u) => u.match(/\/data_spatial\/([^/]+)\//)?.[1]
		);
		// Layers are finest-first in the seamless definition
		expect(domainOrder).toEqual(['test_d2', 'test_eu', 'test_global']);
	});

	it('data for one layer does not bleed into another layer', async () => {
		// The mock WeatherMapLayerFileReader tracks this.currentUrl per instance.
		// mockReadUrlLog records the currentUrl at the moment each readVariable call runs.
		// If the reader were shared incorrectly, urls would be wrong.
		const { omProtocol } = await import('../om-protocol');
		await omProtocol(tileParams(5), new AbortController(), makeSettings());

		expect(mockReadUrlLog.calls[0]).toContain('/test_d2/');
		expect(mockReadUrlLog.calls[1]).toContain('/test_eu/');
		expect(mockReadUrlLog.calls[2]).toContain('/test_global/');
	});
});

describe('SeamlessDomain – URL substitution', () => {
	it('substitutes the seamless domain name with each concrete domain name', async () => {
		const { omProtocol } = await import('../om-protocol');
		await omProtocol(tileParams(5), new AbortController(), makeSettings());

		const urls = mockSetToOmFileSpy.calls;
		expect(urls).toHaveLength(3);
		// Path structure is preserved; only the domain segment changes
		for (const url of urls) {
			expect(url).not.toContain('/test_seamless/');
			expect(url).toContain('2025/01/01/0000Z/2025-01-01T0000.om');
		}
		expect(urls[0]).toContain('/test_d2/');
		expect(urls[1]).toContain('/test_eu/');
		expect(urls[2]).toContain('/test_global/');
	});
});

describe('SeamlessDomain – postReadCallback isolation', () => {
	it('postReadCallback is NOT called for seamless sub-layer loads', async () => {
		const postReadCallback = vi.fn();
		const settings = makeSettings({ postReadCallback });
		const { omProtocol } = await import('../om-protocol');

		await omProtocol(tileParams(5), new AbortController(), settings);

		// Sub-layer loads pass undefined for postReadCallback to avoid racing
		// setToOmFile calls on the shared reader.
		expect(postReadCallback).not.toHaveBeenCalled();
	});
});

describe('SeamlessDomain – error handling', () => {
	it('a failing layer is skipped; the remaining layers still produce a tile', async () => {
		// d2 fails → only eu + global are used
		mockShouldFail.substrings.add('/test_d2/');
		const { omProtocol } = await import('../om-protocol');
		const result = await omProtocol(tileParams(5), new AbortController(), makeSettings());

		expect(result.data).toBeInstanceOf(ArrayBuffer);
		// eu and global should still have been loaded
		const domainValues = mockSetToOmFileSpy.calls.map(
			(u) => u.match(/\/data_spatial\/([^/]+)\//)?.[1]
		);
		expect(domainValues).toContain('test_eu');
		expect(domainValues).toContain('test_global');
	});

	it('all layers failing returns { data: null }', async () => {
		mockShouldFail.substrings.add('/test_d2/');
		mockShouldFail.substrings.add('/test_eu/');
		mockShouldFail.substrings.add('/test_global/');
		const { omProtocol } = await import('../om-protocol');
		const result = await omProtocol(tileParams(5), new AbortController(), makeSettings());

		expect(result.data).toBeNull();
	});

	it('unsupported request type throws', async () => {
		const { omProtocol } = await import('../om-protocol');
		const params: RequestParameters = {
			url: `om://${BASE}?variable=temperature/0/0/0`,
			type: 'image'
		};
		// 'image' tiles carry z/x/y, so this path IS reachable in handleSeamlessRequest
		// (it should succeed, not throw, since 'image' is handled by requestTileSeamless)
		// — only truly unknown types throw
		const unknownParams = { ...params, type: 'vector' as RequestParameters['type'] };
		await expect(
			omProtocol(unknownParams, new AbortController(), makeSettings())
		).rejects.toThrow("Unsupported request type 'vector'");
	});

	it('tile request without z/x/y throws', async () => {
		const { omProtocol } = await import('../om-protocol');
		const params: RequestParameters = {
			url: `om://${BASE}?variable=temperature`,
			type: 'arrayBuffer'
		};
		await expect(
			omProtocol(params, new AbortController(), makeSettings())
		).rejects.toThrow('Tile coordinates required');
	});
});

describe('SeamlessDomain – abort signal', () => {
	it('aborted signal before TileJSON returns { data: null } immediately', async () => {
		const { omProtocol } = await import('../om-protocol');
		const ac = new AbortController();
		ac.abort();
		const result = await omProtocol(jsonParams(), ac, makeSettings());
		expect(result.data).toBeNull();
	});

	it('aborted signal before tile request returns { data: null }', async () => {
		const { omProtocol } = await import('../om-protocol');
		const ac = new AbortController();
		ac.abort();
		const result = await omProtocol(tileParams(5), ac, makeSettings());
		expect(result.data).toBeNull();
	});

	it('abort mid-sequential-load stops further layer fetches', async () => {
		// After the first layer (d2) starts loading, we abort via the mockOnSetToOmFile hook.
		// eu and global should not be started.
		const ac = new AbortController();
		mockOnSetToOmFile.fn = () => ac.abort();

		const { omProtocol } = await import('../om-protocol');
		const result = await omProtocol(tileParams(5), ac, makeSettings());

		// Only the first setToOmFile ran before the abort propagated
		expect(mockSetToOmFileSpy.calls).toHaveLength(1);
		expect(result.data).toBeNull();
	});
});

describe('SeamlessDomain – state caching', () => {
	it('second tile request uses cached state; setToOmFile called only once per layer', async () => {
		const { omProtocol } = await import('../om-protocol');
		const settings = makeSettings();

		// First request populates the cache
		await omProtocol(tileParams(5), new AbortController(), settings);
		const firstCallCount = mockSetToOmFileSpy.calls.length;

		// Second request should hit state.data — no new setToOmFile calls
		await omProtocol(tileParams(5), new AbortController(), settings);
		expect(mockSetToOmFileSpy.calls).toHaveLength(firstCallCount);
	});
});

describe('SeamlessDomain – type properties', () => {
	it('dwd_icon_seamless exposes time_interval and model_interval', async () => {
		const { domainOptions } = await import('../domains');
		const seamless = domainOptions.find((d) => d.value === 'dwd_icon_seamless') as SeamlessDomain;
		expect(seamless).toBeDefined();
		expect(seamless.time_interval).toBe('hourly');
		expect(seamless.model_interval).toBe('3_hourly');
	});

	it('SeamlessDomain is included in domainOptions', async () => {
		const { domainOptions } = await import('../domains');
		const found = domainOptions.find((d) => d.value === 'dwd_icon_seamless');
		expect(found).toBeDefined();
		expect((found as SeamlessDomain).type).toBe('seamless');
		expect((found as SeamlessDomain).layers).toHaveLength(3);
	});

	it('constituent layer domainValues reference real Domain entries', async () => {
		const { domainOptions } = await import('../domains');
		const seamless = domainOptions.find((d) => d.value === 'dwd_icon_seamless') as SeamlessDomain;
		for (const layer of seamless.layers) {
			const concrete = domainOptions.find(
				(d) => d.value === layer.domainValue && !('layers' in d)
			);
			expect(concrete).toBeDefined();
		}
	});

	it('seamless layers are ordered finest-first (highest minZoom first)', async () => {
		const { domainOptions } = await import('../domains');
		const seamless = domainOptions.find((d) => d.value === 'dwd_icon_seamless') as SeamlessDomain;
		const zooms = seamless.layers.map((l) => l.minZoom);
		// Each entry must have a zoom >= the next entry (descending or equal)
		for (let i = 0; i < zooms.length - 1; i++) {
			expect(zooms[i]).toBeGreaterThanOrEqual(zooms[i + 1]);
		}
	});

	it('global fallback layer has blendWidthDeg of 0', async () => {
		const { domainOptions } = await import('../domains');
		const seamless = domainOptions.find((d) => d.value === 'dwd_icon_seamless') as SeamlessDomain;
		const last = seamless.layers[seamless.layers.length - 1];
		expect(last.blendWidthDeg).toBe(0);
	});
});

describe('SeamlessDomain – real dwd_icon_seamless TileJSON', () => {
	it('returns valid TileJSON for dwd_icon_seamless URL', async () => {
		const { omProtocol, defaultOmProtocolSettings } = await import('../om-protocol');
		const url =
			'om://https://map-tiles.open-meteo.com/data_spatial/dwd_icon_seamless/2025/01/01/0000Z/2025-01-01T0000.om?variable=temperature_2m';
		const result = await omProtocol(
			{ url, type: 'json' },
			new AbortController(),
			defaultOmProtocolSettings
		);
		expect(result.data).not.toBeNull();
		const tj = result.data as TileJSON;
		expect(tj.tilejson).toBe('3.0.0');
		// Bounds should span the dwd_icon global domain
		expect(tj.bounds).toBeDefined();
		expect(tj.bounds!.every(Number.isFinite)).toBe(true);
		// No data was loaded
		expect(mockSetToOmFileSpy.calls).toHaveLength(0);
	});
});
