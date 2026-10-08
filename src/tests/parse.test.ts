import { pad } from '../utils';
import { fetchRunTimeStepHours, parseMetaJson, parseUrlComponents } from '../utils/parse-url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('URL Parsing', () => {
	describe('parseMetaJson', () => {
		// parseMetaJson fetches the meta json itself; stub the network so the
		// tests are deterministic and run offline
		beforeEach(() => {
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => ({
					ok: true,
					json: async () => ({
						completed: true,
						last_modified_time: new Date().toISOString(),
						reference_time: new Date().toISOString(),
						valid_times: [new Date().toISOString()],
						variables: ['temperature_2m']
					})
				}))
			);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it('resolves latest.json to current model run URL', async () => {
			const url =
				'https://openmeteo.s3.amazonaws.com/data_spatial/dwd_icon/latest.json?time_step=current_time_1H&variable=temperature_2m';
			const parsedUrl = await parseMetaJson(url);
			const now = new Date();

			expect(parsedUrl).not.toContain('latest');
			expect(parsedUrl).toContain(
				`/${now.getUTCFullYear()}/${pad(now.getUTCMonth() + 1)}/${pad(now.getUTCDate())}/`
			);
			expect(parsedUrl).not.toContain('current_time_1H');
		});

		it('resolves in-progress.json to current model run URL', async () => {
			const url =
				'https://openmeteo.s3.amazonaws.com/data_spatial/dwd_icon/in-progress.json?time_step=current_time_1H&variable=temperature_2m';
			const parsedUrl = await parseMetaJson(url);

			expect(parsedUrl).not.toContain('in-progress');
		});
	});

	describe('parseUrlComponents', () => {
		it('parses URL with query params and tile coordinates', async () => {
			const url =
				'om://https://example.com/data_spatial/domain1/file.om?variable=temp&dark=true/5/10/15';
			const components = parseUrlComponents(url);

			expect(components.baseUrl).toBe('https://example.com/data_spatial/domain1/file.om');
			expect(components.params.get('variable')).toBe('temp');
			expect(components.params.get('dark')).toBe('true');
			expect(components.tileIndex).toEqual({ z: 5, x: 10, y: 15 });
		});

		it('parses URL without tile coordinates (tilejson request)', async () => {
			const url = 'om://https://example.com/data_spatial/domain1/file.om?variable=temp';
			const components = parseUrlComponents(url);

			expect(components.baseUrl).toBe('https://example.com/data_spatial/domain1/file.om');
			expect(components.tileIndex).toBeNull();
		});

		it('excludes rendering-only params from stateKey', async () => {
			const url1 =
				'om://https://example.com/data_spatial/domain1/file.om?variable=temp&tile_size=512';
			const url2 =
				'om://https://example.com/data_spatial/domain1/file.om?variable=temp&tile_size=256';

			const components1 = parseUrlComponents(url1);
			const components2 = parseUrlComponents(url2);

			// Same stateKey despite different tile_size
			expect(components1.fileAndVariableKey).toBe(components2.fileAndVariableKey);
		});

		it('includes data-affecting params in stateKey', async () => {
			const url1 = 'om://https://example.com/data_spatial/domain1/file.om?variable=temp';
			const url2 = 'om://https://example.com/data_spatial/domain1/file.om?variable=humidity';

			const components1 = parseUrlComponents(url1);
			const components2 = parseUrlComponents(url2);

			expect(components1.fileAndVariableKey).not.toBe(components2.fileAndVariableKey);
		});

		it('rejects invalid OM protocol URL', async () => {
			expect(() => parseUrlComponents('https://example.com/file.om')).toThrow(
				'Invalid OM protocol URL'
			);
		});
	});
});

describe('fetchRunTimeStepHours', () => {
	// A run with hourly steps that turn 3-hourly, listed out of order
	const meta = {
		completed: true,
		last_modified_time: '',
		reference_time: '2026-10-08T00:00Z',
		valid_times: [
			'2026-10-08T01:00Z',
			'2026-10-08T00:00Z',
			'2026-10-08T05:00Z',
			'2026-10-08T02:00Z'
		],
		variables: ['precipitation']
	};
	const run = 'https://host/data_spatial/model/2026/10/08/0000Z';

	beforeEach(() =>
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json(meta))
		)
	);
	afterEach(() => vi.unstubAllGlobals());

	it('is the gap to the previous valid time of the run', async () => {
		expect(await fetchRunTimeStepHours(`${run}/2026-10-08T0200.om`)).toBe(1);
		expect(await fetchRunTimeStepHours(`${run}/2026-10-08T0500.om`)).toBe(3);
		// The first step takes the gap to the next one
		expect(await fetchRunTimeStepHours(`${run}/2026-10-08T0000.om`)).toBe(1);
		expect(fetch).toHaveBeenCalledWith(`${run}/meta.json`);
	});

	it('is undefined for a valid time the run does not list, or a URL outside a run', async () => {
		expect(await fetchRunTimeStepHours(`${run}/2026-10-08T0400.om`)).toBeUndefined();
		expect(await fetchRunTimeStepHours('https://host/file.om')).toBeUndefined();
	});
});
