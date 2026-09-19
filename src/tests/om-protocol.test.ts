import { WeatherMapLayerFileReader } from '../om-file-reader';
import { defaultOmProtocolSettings } from '../om-protocol';
import { parseRequest } from '../utils/parse-request';
import { RequestParameters } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	DimensionRange,
	Domain,
	GridData,
	OmProtocolSettings,
	ResolvedBreakpointColorScale,
	TileJSON
} from '../types';

const { mockReturnBuffer, mockReadVariableResult, mockReadGridData } = vi.hoisted(() => ({
	mockReturnBuffer: { value: new ArrayBuffer(16) },
	mockReadVariableResult: { value: null as { values: Float32Array; directions: undefined } | null },
	// Grid "read from the file" for domains that are not in the catalogue.
	mockReadGridData: {
		grid: { type: 'regular', nx: 4, ny: 3, lonMin: 0, latMin: 0, dx: 1, dy: 1 } as GridData,
		calls: [] as [string, string][]
	}
}));

vi.mock('../om-file-reader', async () => {
	const actual = await vi.importActual('../om-file-reader');
	return {
		...actual,
		WeatherMapLayerFileReader: class {
			config = {};
			async readVariable(_url: string, _variable: string, ranges: DimensionRange[]) {
				if (mockReadVariableResult.value) {
					return mockReadVariableResult.value;
				}
				const totalValues =
					ranges?.reduce((acc, range) => acc * (range.end - range.start + 1), 1) || 0;
				return { values: new Float32Array(totalValues), directions: undefined };
			}
			async readGridData(url: string, variable: string): Promise<GridData> {
				mockReadGridData.calls.push([url, variable]);
				return mockReadGridData.grid;
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
	mockReadGridData.calls.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
});

const createTestDomain = (value: string, grid = {}): Domain => ({
	value,
	label: `Test ${value}`,
	grid: {
		type: 'regular',
		nx: 10,
		ny: 20,
		lonMin: 0,
		latMin: 0,
		dx: 1,
		dy: 1,
		...grid
	},
	time_interval: 'hourly',
	model_interval: '3_hourly'
});

const createTestSettings = (overrides: Partial<OmProtocolSettings> = {}): OmProtocolSettings => ({
	...defaultOmProtocolSettings,
	...overrides
});

/** Parse with a (mocked) file reader, as the protocol does. */
const parse = (url: string, settings: OmProtocolSettings) =>
	parseRequest(url, settings, new WeatherMapLayerFileReader());

describe('Request Options', () => {
	describe('parseRequest', () => {
		it('resolves data identity and render options from URL', async () => {
			const domainOptions = [createTestDomain('domain1')];
			const settings = createTestSettings({ domainOptions });

			const url =
				'om://https://example.com/data_spatial/domain1/file.om?variable=temperature&dark=true&intervals=2';
			const { dataOptions, renderOptions } = await parse(url, settings);

			expect(dataOptions.domain?.value).toBe('domain1');
			expect(dataOptions.variable).toBe('temperature');
			expect(renderOptions.intervals).toStrictEqual([2]);
		});

		it('draws barbs only for wind speeds, arrows otherwise', async () => {
			const settings = createTestSettings({ domainOptions: [createTestDomain('domain1')] });
			const base =
				'om://https://example.com/data_spatial/domain1/file.om?arrows=true&arrow_style=barb';

			expect(
				(await parse(`${base}&variable=wind_u_component_10m`, settings)).renderOptions.arrowStyle
			).toBe('barb');
			expect((await parse(`${base}&variable=wave_height`, settings)).renderOptions.arrowStyle).toBe(
				'arrow'
			);
			expect(
				(await parse(`${base}&variable=ocean_u_current`, settings)).renderOptions.arrowStyle
			).toBe('arrow');
		});

		it('can resolve domain from a variety of different urls', async () => {
			const domainOptions = [createTestDomain('domain1')];
			const settings = createTestSettings({ domainOptions });

			const url1 =
				'om://https://nested.subdomain.of.example.com/data_spatial/domain1/file.om?variable=temperature&dark=true&intervals=2';

			const url2 =
				'om://http:/nested.subdomain.of.example.com/data_spatial/domain1/file.om?variable=temperature&dark=true&intervals=2';

			const url3 =
				'om://https://example.com/nested/bucket/structure/data_spatial/domain1/file.om?variable=temperature&dark=true&intervals=2';

			for (const url of [url1, url2, url3]) {
				const { dataOptions, renderOptions } = await parse(url, settings);
				expect(dataOptions.domain?.value).toBe('domain1');
				expect(dataOptions.variable).toBe('temperature');
				expect(renderOptions.intervals).toStrictEqual([2]);
			}
		});

		it('resolves domain from urls without a data_spatial prefix', async () => {
			const domainOptions = [createTestDomain('domain1')];
			const settings = createTestSettings({ domainOptions });

			const url1 =
				'om://https://example.com/domain1/2026/07/13/0600Z/2026-07-13T1300.om?variable=temperature&dark=true&intervals=2';

			const url2 =
				'om://https://example.com/nested/bucket/structure/domain1/2026/07/13/0600Z/2026-07-13T1300.om?variable=temperature&dark=true&intervals=2';

			// Bare .om file with neither a data_spatial prefix nor a model-run path.
			const url3 =
				'om://https://example.com/domain1/file.om?variable=temperature&dark=true&intervals=2';

			const url4 =
				'om://https://example.com/nested/bucket/structure/domain1/file.om?variable=temperature&dark=true&intervals=2';

			for (const url of [url1, url2, url3, url4]) {
				const { dataOptions, renderOptions } = await parse(url, settings);
				expect(dataOptions.domain?.value).toBe('domain1');
				expect(dataOptions.variable).toBe('temperature');
				expect(renderOptions.intervals).toStrictEqual([2]);
			}
		});

		it('reads the grid from the file for a domain not in the catalogue', async () => {
			const settings = createTestSettings({ domainOptions: [] });
			const url = 'om://https://example.com/data_spatial/unknown/file.om?variable=temp';

			const { dataOptions } = await parse(url, settings);

			expect(dataOptions.domain).toBeUndefined();
			expect(dataOptions.grid).toEqual(mockReadGridData.grid);
			expect(mockReadGridData.calls).toEqual([
				['https://example.com/data_spatial/unknown/file.om', 'temp']
			]);
		});

		it('takes the grid from the catalogue without reading the file', async () => {
			const domainOptions = [createTestDomain('domain1')];
			const settings = createTestSettings({ domainOptions });
			const url = 'om://https://example.com/data_spatial/domain1/file.om?variable=temp';

			const { dataOptions } = await parse(url, settings);

			expect(dataOptions.grid).toEqual(domainOptions[0].grid);
			expect(mockReadGridData.calls).toEqual([]);
		});

		it('throws for missing variable', async () => {
			const domainOptions = [createTestDomain('domain1')];
			const settings = createTestSettings({ domainOptions });
			const url = 'om://https://example.com/data_spatial/domain1/file.om';

			await expect(parse(url, settings)).rejects.toThrow('Variable is required but not defined');
		});

		it('parses render options with defaults', async () => {
			const domainOptions = [createTestDomain('domain1')];
			const settings = createTestSettings({ domainOptions });

			const url = 'om://https://example.com/data_spatial/domain1/file.om?variable=temp';
			const { renderOptions } = await parse(url, settings);

			const colorScale = renderOptions.colorScale as ResolvedBreakpointColorScale;

			expect(renderOptions.tileSize).toBe(512);
			expect(renderOptions.drawGrid).toBe(false);
			expect(renderOptions.drawArrows).toBe(false);
			expect(renderOptions.drawContours).toBe(false);
			expect(renderOptions.intervals).toStrictEqual(colorScale.breakpoints);
		});

		it('parses custom render options', async () => {
			const domainOptions = [createTestDomain('domain1')];
			const settings = createTestSettings({ domainOptions });

			const url =
				'om://https://example.com/data_spatial/domain1/file.om?variable=temp&tile_size=1024&grid=true&arrows=true&contours=true';
			const { renderOptions } = await parse(url, settings);

			expect(renderOptions.tileSize).toBe(1024);
			expect(renderOptions.drawGrid).toBe(true);
			expect(renderOptions.drawArrows).toBe(true);
			expect(renderOptions.drawContours).toBe(true);
		});

		it('throws for invalid tile size', async () => {
			const domainOptions = [createTestDomain('domain1')];
			const settings = createTestSettings({ domainOptions });

			const url =
				'om://https://example.com/data_spatial/domain1/file.om?variable=temp&tile_size=999';

			await expect(parse(url, settings)).rejects.toThrow('Invalid tile size');
		});

		it('resolves clipping options and caches by reference', async () => {
			const domainOptions = [createTestDomain('domain1')];
			const clippingOptions = {
				bounds: [-10, -10, 10, 10] as [number, number, number, number]
			};
			const settings = createTestSettings({ domainOptions, clippingOptions });
			const url = 'om://https://example.com/data_spatial/domain1/file.om?variable=temp';

			const result1 = await parse(url, settings);
			const result2 = await parse(url, settings);

			// Same reference for clippingOptions means cached result is reused
			expect(result1.clippingOptions).toBeDefined();
			expect(result1.clippingOptions).toBe(result2.clippingOptions);
			expect(result1.clippingOptions!.bounds).toBeDefined();
		});

		it('returns undefined clippingOptions when none provided', async () => {
			const domainOptions = [createTestDomain('domain1')];
			const settings = createTestSettings({ domainOptions });
			const url = 'om://https://example.com/data_spatial/domain1/file.om?variable=temp';

			const result = await parse(url, settings);
			expect(result.clippingOptions).toBeUndefined();
		});
	});

	describe('custom resolver', () => {
		it('allows custom request resolver', async () => {
			const { omProtocol } = await import('../om-protocol');

			const customResolver = vi.fn().mockReturnValue({
				dataOptions: {
					domain: createTestDomain('custom_domain'),
					grid: createTestDomain('custom_domain').grid,
					variable: { value: 'custom_var' },
					ranges: [
						{ start: 0, end: 10 },
						{ start: 0, end: 10 }
					]
				},
				renderOptions: {
					dark: true,
					tileSize: 512,
					makeGrid: false,
					makeArrows: false,
					makeContours: false,
					interval: [2],
					colorScale: {
						min: 0,
						max: 100,
						colors: [],
						unit: 'C'
					}
				}
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
				url: 'om://https://data-spatial.open-meteo.com/data_spatial/dwd_icon/2025/10/27/1200Z/2025-10-27T1200.om?variable=temperature_2m',
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
				url: 'om://https://data-spatial.open-meteo.com/data_spatial/dwd_icon/2025/10/27/1200Z/2025-10-27T1200.om?variable=temperature_2m',
				type: 'json'
			};
			const result = await omProtocol(params, new AbortController(), defaultOmProtocolSettings);
			const resultData = result.data as TileJSON;

			// DWD ICON global bounds
			expect(resultData.bounds).toEqual([-180, -90, 179.875, 90.125]);
		});

		it('returns bounds from the file grid for a domain not in the catalogue', async () => {
			const { omProtocol } = await import('../om-protocol');
			const settings = createTestSettings({ domainOptions: [] });
			const params: RequestParameters = {
				url: 'om://https://example.com/data_spatial/unknown/file.om?variable=temperature_2m',
				type: 'json'
			};
			const result = await omProtocol(params, new AbortController(), settings);
			const resultData = result.data as TileJSON;

			// 4x3 cells of 1 degree from the origin (see mockReadGridData)
			expect(resultData.bounds).toEqual([0, 0, 4, 3]);
		});
	});

	describe('tile requests', () => {
		it('early return for vector requests', async () => {
			const { omProtocol } = await import('../om-protocol');

			const params: RequestParameters = {
				url: 'om://https://data-spatial.open-meteo.com/data_spatial/dwd_icon/2025/10/27/1200Z/2025-10-27T1200.om?variable=temperature_2m/0/0/0',
				type: 'arrayBuffer'
			};
			const result = await omProtocol(params, new AbortController(), defaultOmProtocolSettings);

			expect(result.data).toBeInstanceOf(ArrayBuffer);
			expect(result.data as ArrayBuffer).toEqual(new ArrayBuffer(0));
		});

		it('throws for tile request without coordinates', async () => {
			const { omProtocol } = await import('../om-protocol');

			const params: RequestParameters = {
				url: 'om://https://data-spatial.open-meteo.com/data_spatial/dwd_icon/2025/10/27/1200Z/2025-10-27T1200.om?variable=temperature_2m',
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
				url: 'om://https://data-spatial.open-meteo.com/data_spatial/dwd_icon/2025/10/27/1200Z/2025-10-27T1200.om?variable=temperature_2m/0/0/0',
				type: 'arrayBuffer'
			};

			await omProtocol(params, new AbortController(), settings);

			expect(postReadCallback).toHaveBeenCalledTimes(1);
			expect(postReadCallback).toHaveBeenCalledWith(
				expect.anything(), // omFileReader
				expect.objectContaining({ values: expect.any(Float32Array) }), // data
				expect.objectContaining({
					omFileUrl: expect.stringContaining('data-spatial.open-meteo.com')
				})
			);
		});
	});
});

describe('getValueFromLatLong', () => {
	it('returns interpolated value from loaded state', async () => {
		const { omProtocol } = await import('../om-protocol');
		const { getValueFromLatLong } = await import('../om-protocol-state');

		// First load data via tile request
		const url =
			'om://https://data-spatial.open-meteo.com/data_spatial/dwd_icon/2025/10/27/1200Z/2025-10-27T1200.om?variable=temperature_2m/0/0/0';
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
				url: 'om://https://data-spatial.open-meteo.com/data_spatial/dwd_icon/2025/10/27/1200Z/2025-10-27T1200.om?variable=temperature_2m/0/0/0',
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
