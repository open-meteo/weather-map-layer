import { WeatherMapLayerFileReader } from '../om-file-reader';
import { defaultOmProtocolSettings } from '../om-protocol';
import { parseRequest } from '../utils/parse-request';
import { RequestParameters } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	DataIdentityOptions,
	DimensionRange,
	GridData,
	OmProtocolSettings,
	RenderOptions,
	ResolvedBreakpointColorScale,
	TileJSON
} from '../types';

const { mockReturnBuffer, mockReadVariableResult } = vi.hoisted(() => ({
	mockReturnBuffer: { value: new ArrayBuffer(16) },
	mockReadVariableResult: { value: null as { values: Float32Array; directions: undefined } | null }
}));

vi.mock('../om-file-reader', async () => {
	const actual = await vi.importActual('../om-file-reader');
	return {
		...actual,
		WeatherMapLayerFileReader: class {
			config = {};
			async setToOmFile() {}
			async readVariable(_variable: string, ranges: DimensionRange[]) {
				if (mockReadVariableResult.value) {
					return mockReadVariableResult.value;
				}
				const totalValues =
					ranges?.reduce((acc, range) => acc * (range.end - range.start + 1), 1) || 0;
				return { values: new Float32Array(totalValues), directions: undefined };
			}
			async getGridParameters(_variable: string): Promise<GridData> {
				return {
					type: 'regular',
					nx: 10,
					ny: 20,
					lonMin: 0,
					latMin: 0,
					dx: 1,
					dy: 1
				};
			}
		}
	};
});

vi.mock('../worker-pool', () => ({
	WorkerPool: class {
		requestTile = vi.fn(() => Promise.resolve(mockReturnBuffer.value));
	}
}));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	mockReturnBuffer.value = new ArrayBuffer(16);
	mockReadVariableResult.value = null;
});

afterEach(() => {
	vi.restoreAllMocks();
});

const createTestSettings = (overrides: Partial<OmProtocolSettings> = {}): OmProtocolSettings => ({
	...defaultOmProtocolSettings,
	...overrides
});

/** Returns the om-file path for the first day of the previous calendar month (1200Z run). */
const getFirstDayLastMonthOmPath = (): string => {
	const d = new Date();
	d.setDate(1); // prevent month overflow when subtracting
	d.setMonth(d.getMonth() - 1);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	return `dwd_icon/${y}/${m}/01/1200Z/${y}-${m}-01T1200.om`;
};

const DWD_ICON_BASE_URL = `om://https://map-tiles.open-meteo.com/data_spatial/${getFirstDayLastMonthOmPath()}?variable=temperature_2m`;

describe('Request Options', () => {
	describe('parseRequest', () => {
		it('resolves data identity and render options from URL', async () => {
			const settings = createTestSettings();
			const reader = new WeatherMapLayerFileReader();

			const url =
				'om://https://example.com/data_spatial/domain1/file.om?variable=temperature&dark=true&intervals=2';
			const { dataOptions, renderOptions } = await parseRequest(url, settings, reader);

			expect(dataOptions.baseUrl).toBe('https://example.com/data_spatial/domain1/file.om');
			expect(dataOptions.variable).toBe('temperature');
			expect(renderOptions.intervals).toStrictEqual([2]);
		});

		it('can resolve domain from a variety of different urls', async () => {
			const settings = createTestSettings();
			const reader = new WeatherMapLayerFileReader();

			const url1 =
				'om://https://nested.subdomain.of.example.com/data_spatial/domain1/file.om?variable=temperature&dark=true&intervals=2';

			const url2 =
				'om://http:/nested.subdomain.of.example.com/data_spatial/domain1/file.om?variable=temperature&dark=true&intervals=2';

			const url3 =
				'om://https://example.com/nested/bucket/structure/data_spatial/domain1/file.om?variable=temperature&dark=true&intervals=2';

			for (const url of [url1, url2, url3]) {
				const { dataOptions, renderOptions } = await parseRequest(url, settings, reader);
				expect(dataOptions.baseUrl).toContain('data_spatial/domain1/file.om');
				expect(dataOptions.variable).toBe('temperature');
				expect(renderOptions.intervals).toStrictEqual([2]);
			}
		});

		it('throws for missing variable', async () => {
			const settings = createTestSettings();
			const reader = new WeatherMapLayerFileReader();
			const url = 'om://https://example.com/data_spatial/domain1/file.om';

			await expect(parseRequest(url, settings, reader)).rejects.toThrow(
				'Variable is required but not defined'
			);
		});

		it('parses render options with defaults', async () => {
			const settings = createTestSettings();
			const reader = new WeatherMapLayerFileReader();

			const url = 'om://https://example.com/data_spatial/domain1/file.om?variable=temp';
			const { renderOptions } = await parseRequest(url, settings, reader);

			const colorScale = renderOptions.colorScale as ResolvedBreakpointColorScale;

			expect(renderOptions.tileSize).toBe(512);
			expect(renderOptions.drawGrid).toBe(false);
			expect(renderOptions.drawArrows).toBe(false);
			expect(renderOptions.drawContours).toBe(false);
			expect(renderOptions.intervals).toStrictEqual(colorScale.breakpoints);
			expect(renderOptions.colorScale.colors.length).toBe(46);
		});

		it('parses custom render options', async () => {
			const settings = createTestSettings();
			const reader = new WeatherMapLayerFileReader();

			const url =
				'om://https://example.com/data_spatial/domain1/file.om?variable=temp&tile_size=1024&grid=true&arrows=true&contours=true';
			const { renderOptions } = await parseRequest(url, settings, reader);

			expect(renderOptions.tileSize).toBe(1024);
			expect(renderOptions.drawGrid).toBe(true);
			expect(renderOptions.drawArrows).toBe(true);
			expect(renderOptions.drawContours).toBe(true);
		});

		it('throws for invalid tile size', async () => {
			const settings = createTestSettings();
			const reader = new WeatherMapLayerFileReader();

			const url =
				'om://https://example.com/data_spatial/domain1/file.om?variable=temp&tile_size=999';

			await expect(parseRequest(url, settings, reader)).rejects.toThrow('Invalid tile size');
		});

		it('resolves clipping options and caches by reference', async () => {
			const clippingOptions = {
				bounds: [-10, -10, 10, 10] as [number, number, number, number]
			};
			const settings = createTestSettings({ clippingOptions });
			const url = 'om://https://example.com/data_spatial/domain1/file.om?variable=temp';
			const reader = new WeatherMapLayerFileReader();

			const result1 = await parseRequest(url, settings, reader);
			const result2 = await parseRequest(url, settings, reader);

			// Same reference for clippingOptions means cached result is reused
			expect(result1.clippingOptions).toBeDefined();
			expect(result1.clippingOptions).toBe(result2.clippingOptions);
			expect(result1.clippingOptions!.bounds).toBeDefined();
		});

		it('returns undefined clippingOptions when none provided', async () => {
			const settings = createTestSettings();
			const url = 'om://https://example.com/data_spatial/domain1/file.om?variable=temp';
			const reader = new WeatherMapLayerFileReader();

			const result = await parseRequest(url, settings, reader);
			expect(result.clippingOptions).toBeUndefined();
		});
	});

	describe('custom resolver', () => {
		it('allows custom request resolver', async () => {
			const { omProtocol } = await import('../om-protocol');

			const customResolver = vi.fn().mockImplementation(() => {
				const renderOptions: RenderOptions = {
					tileSize: 512,
					drawGrid: false,
					drawArrows: false,
					drawContours: false,
					intervals: [2],
					colorScale: {
						type: 'rgba',
						min: 0,
						max: 100,
						colors: [],
						unit: 'C'
					}
				};
				const dataOptions: DataIdentityOptions = {
					baseUrl: 'https://example.com/data_spatial/custom_domain',
					grid: { type: 'regular', ny: 10, nx: 10, lonMin: 0, latMin: 0, dx: 1, dy: 1 },
					variable: 'custom_var',
					bounds: undefined
				};
				return {
					dataOptions,
					renderOptions
				};
			});

			const settings = createTestSettings({ resolveRequest: customResolver });

			const params: RequestParameters = {
				url: 'om://https://example.com/data_spatial/custom_domain/file.om?variable=custom_var/0/0/0',
				type: 'arrayBuffer'
			};

			await omProtocol(params, new AbortController(), settings);

			expect(customResolver).toHaveBeenCalled();
		});
	});
});

describe('omProtocol', () => {
	describe('TileJSON requests', () => {
		it('returns tilejson with correct tiles URL', async () => {
			const { omProtocol } = await import('../om-protocol');
			const params: RequestParameters = {
				url: DWD_ICON_BASE_URL,
				type: 'json'
			};
			const result = await omProtocol(params, new AbortController(), defaultOmProtocolSettings);
			const resultData = result.data as TileJSON;

			expect(resultData.tilejson).toBe('3.0.0');
			expect(resultData.tiles[0]).toBe(params.url + '/{z}/{x}/{y}');
			expect(resultData.attribution).toContain('Open-Meteo');
			expect(resultData.minzoom).toBe(0);
			expect(resultData.maxzoom).toBe(12);
			expect(resultData.bounds).toBeDefined();
		});

		it('returns correct bounds for domain grid', async () => {
			const { omProtocol } = await import('../om-protocol');
			const params: RequestParameters = {
				url: DWD_ICON_BASE_URL,
				type: 'json'
			};
			const result = await omProtocol(params, new AbortController(), defaultOmProtocolSettings);
			const resultData = result.data as TileJSON;

			// Mocked reader bounds
			expect(resultData.bounds).toEqual([0, 0, 10, 20]);
		});
	});

	describe('tile requests', () => {
		it('early return for vector requests', async () => {
			const { omProtocol } = await import('../om-protocol');

			const params: RequestParameters = {
				url: `${DWD_ICON_BASE_URL}/0/0/0`,
				type: 'arrayBuffer'
			};
			const result = await omProtocol(params, new AbortController(), defaultOmProtocolSettings);

			expect(result.data).toBeInstanceOf(ArrayBuffer);
			expect(result.data as ArrayBuffer).toEqual(new ArrayBuffer(0));
		});

		it('throws for tile request without coordinates', async () => {
			const { omProtocol } = await import('../om-protocol');

			const params: RequestParameters = {
				url: DWD_ICON_BASE_URL,
				type: 'arrayBuffer'
			};

			await expect(
				omProtocol(params, new AbortController(), defaultOmProtocolSettings)
			).rejects.toThrow('Tile coordinates required');
		});

		it('calls postReadCallback after data is loaded', async () => {
			const { omProtocol } = await import('../om-protocol');

			const postReadCallback = vi.fn();
			const settings = createTestSettings({ postReadCallback });

			const params: RequestParameters = {
				url: `${DWD_ICON_BASE_URL}/0/0/0`,
				type: 'arrayBuffer'
			};

			await omProtocol(params, new AbortController(), settings);

			expect(postReadCallback).toHaveBeenCalledTimes(1);
			expect(postReadCallback).toHaveBeenCalledWith(
				expect.anything(), // omFileReader
				expect.objectContaining({ values: expect.any(Float32Array) }), // data
				expect.objectContaining({ omFileUrl: expect.stringContaining('map-tiles.open-meteo.com') })
			);
		});
	});
});

describe('getValueFromLatLong', () => {
	it('returns interpolated value from loaded state', async () => {
		const { omProtocol } = await import('../om-protocol');
		const { getValueFromLatLong } = await import('../om-protocol-state');

		// First load data via tile request
		const url = `${DWD_ICON_BASE_URL}/0/0/0`;
		await omProtocol(
			{ url, type: 'arrayBuffer' },
			new AbortController(),
			defaultOmProtocolSettings
		);

		// Then query value
		const result = await getValueFromLatLong(0, 0, url);

		expect(result.value).toBe(0); // Mock returns zeros
	});

	it('throws when protocol not initialized', async () => {
		const { getValueFromLatLong } = await import('../om-protocol-state');

		await expect(
			getValueFromLatLong(
				0,
				0,
				'om://https://example.com/data_spatial/dwd_icon/file.om?variable=temp'
			)
		).rejects.toThrow('OmProtocolInstance is not initialized');
	});

	it('throws when state not found', async () => {
		const { omProtocol } = await import('../om-protocol');
		const { getValueFromLatLong } = await import('../om-protocol-state');

		// Initialize protocol with one URL
		await omProtocol(
			{
				url: `${DWD_ICON_BASE_URL}/0/0/0`,
				type: 'arrayBuffer'
			},
			new AbortController(),
			defaultOmProtocolSettings
		);

		// Query with different URL
		await expect(
			getValueFromLatLong(
				0,
				0,
				'om://https://example.com/data_spatial/dwd_icon/other.om?variable=other'
			)
		).rejects.toThrow('State not found');
	});
});

describe('omProtocol', () => {
	describe('TileJSON requests', () => {
		beforeEach(() => {
			vi.resetModules();
			// FIXME: This is extremely ugly. Any test after these tests will not have the om-file-reader mock available anymore.
			vi.doUnmock('../om-file-reader');
		});

		afterEach(() => {
			// Re-establish mock for tests outside this block
			vi.resetModules();
		});
		it('returns tilejson with correct tiles URL', async () => {
			const { omProtocol } = await import('../om-protocol');
			const params: RequestParameters = {
				url: 'om://https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json?variable=temperature_2m',
				type: 'json'
			};
			const result = await omProtocol(params, new AbortController(), defaultOmProtocolSettings);
			const resultData = result.data as TileJSON;

			expect(resultData.tilejson).toBe('3.0.0');
			expect(resultData.tiles[0]).toBe(params.url + '/{z}/{x}/{y}');
			expect(resultData.attribution).toContain('Open-Meteo');
			expect(resultData.minzoom).toBe(0);
			expect(resultData.maxzoom).toBe(12);
			expect(resultData.bounds).toBeDefined();
		});

		it('returns correct bounds for domain grid', async () => {
			const { omProtocol } = await import('../om-protocol');
			const params: RequestParameters = {
				url: 'om://https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json?variable=temperature_2m',
				type: 'json'
			};
			const result = await omProtocol(params, new AbortController(), defaultOmProtocolSettings);
			const resultData = result.data as TileJSON;

			// DWD ICON global bounds
			expect(resultData.bounds).toEqual([-180, -90, 179.875, 90.125]);
		});
	});

	describe('tile requests', () => {
		it('early return for vector requests', async () => {
			const { omProtocol } = await import('../om-protocol');

			const params: RequestParameters = {
				url: 'om://https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json?variable=temperature_2m/0/0/0',
				type: 'arrayBuffer'
			};
			const result = await omProtocol(params, new AbortController(), defaultOmProtocolSettings);

			expect(result.data).toBeInstanceOf(ArrayBuffer);
			expect(result.data as ArrayBuffer).toEqual(new ArrayBuffer(0));
		});

		it('throws for tile request without coordinates', async () => {
			const { omProtocol } = await import('../om-protocol');

			const params: RequestParameters = {
				url: 'om://https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json?variable=temperature_2m',
				type: 'arrayBuffer'
			};

			await expect(
				omProtocol(params, new AbortController(), defaultOmProtocolSettings)
			).rejects.toThrow('Tile coordinates required');
		});

		it('calls postReadCallback after data is loaded', async () => {
			const { omProtocol } = await import('../om-protocol');

			const postReadCallback = vi.fn();
			const settings = createTestSettings({ postReadCallback });

			const params: RequestParameters = {
				url: 'om://https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json?variable=temperature_2m/0/0/0',
				type: 'arrayBuffer'
			};

			await omProtocol(params, new AbortController(), settings);

			expect(postReadCallback).toHaveBeenCalledTimes(1);
			expect(postReadCallback).toHaveBeenCalledWith(
				expect.anything(), // omFileReader
				expect.objectContaining({ values: expect.any(Float32Array) }), // data
				expect.objectContaining({ omFileUrl: expect.stringContaining('map-tiles.open-meteo.com') })
			);
		});
	});
});
