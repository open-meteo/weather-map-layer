import { pad } from '../utils';
import { assertOmUrlValid, parseMetaJson, parseUrlComponents } from '../utils/parse-url';
import { describe, expect, it } from 'vitest';

describe('URL Parsing', () => {
	describe('parseMetaJson', () => {
		it('resolves latest.json to current model run URL', async () => {
			const url =
				'https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json?time_step=current_time_1H&variable=temperature_2m';
			const parsedUrl = await parseMetaJson(url);
			const now = new Date();

			expect(parsedUrl).not.toContain('latest');
			expect(parsedUrl).toContain(
				`/${now.getUTCFullYear()}/${pad(now.getUTCMonth() + 1)}/${pad(now.getUTCDate())}/`
			);
			expect(parsedUrl).not.toContain('current_time_1H');
			// expect(parsedUrl).toContain(
			// 	`${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours() + 1)}00.om`
			// );
		});

		it('resolves in-progress.json to current model run URL', async () => {
			const url =
				'https://map-tiles.open-meteo.com/data_spatial/dwd_icon/in-progress.json?time_step=current_time_1H&variable=temperature_2m';
			const parsedUrl = await parseMetaJson(url);

			expect(parsedUrl).not.toContain('in-progress');
			assertOmUrlValid(parsedUrl);
		});
	});

	describe('assertOmUrlValid', () => {
		it('accepts valid OM URLs', () => {
			expect(
				assertOmUrlValid(
					'https://map-tiles.open-meteo.com/data_spatial/dwd_icon/2025/11/17/0600Z/2025-11-17T1300.om'
				)
			).toBe(true);
		});

		it('rejects invalid domain', () => {
			expect(() =>
				assertOmUrlValid(
					'https://map-tiles.open-meteo.com/data_spatial/not_a_valid_domain/2025/11/17/0600Z/2025-11-17T1300.om'
				)
			).toThrowError('Invalid Domain');
		});

		it('rejects model run too far in the past', () => {
			expect(() =>
				assertOmUrlValid(
					'https://map-tiles.open-meteo.com/data_spatial/dwd_icon/2024/11/17/0600Z/2025-11-17T1300.om'
				)
			).toThrowError('Model run too far in the past');
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
				'om://https://example.com/data_spatial/domain1/file.om?variable=temp&tile-size=512';
			const url2 =
				'om://https://example.com/data_spatial/domain1/file.om?variable=temp&tile-size=256';

			const components1 = parseUrlComponents(url1);
			const components2 = parseUrlComponents(url2);

			// Same stateKey despite different tile-size
			expect(components1.stateKey).toBe(components2.stateKey);
		});

		it('includes data-affecting params in stateKey', async () => {
			const url1 = 'om://https://example.com/data_spatial/domain1/file.om?variable=temp';
			const url2 = 'om://https://example.com/data_spatial/domain1/file.om?variable=humidity';

			const components1 = parseUrlComponents(url1);
			const components2 = parseUrlComponents(url2);

			expect(components1.stateKey).not.toBe(components2.stateKey);
		});

		it('rejects invalid OM protocol URL', async () => {
			expect(() => parseUrlComponents('https://example.com/file.om')).toThrow(
				'Invalid OM protocol URL'
			);
		});
	});
});
