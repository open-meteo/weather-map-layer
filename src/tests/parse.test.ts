import { pad } from '../utils';
import { assertOmUrlValid, parseMetaJson } from '../utils/parse-url';
import { describe, expect, test } from 'vitest';

const omUrl = `https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json?time_step=current_time_1H&variable=temperature_2m`;

describe('parse OM URL with a model-run', () => {
	test('get latest and replace url', async () => {
		const now = new Date();
		let parsedOmUrl = omUrl;
		if (parsedOmUrl.includes('latest.json')) {
			parsedOmUrl = await parseMetaJson(parsedOmUrl);
		}
		expect(parsedOmUrl).not.toContain('latest');
		expect(parsedOmUrl).toContain(
			`/${now.getUTCFullYear()}/${pad(now.getUTCMonth() + 1)}/${pad(now.getUTCDate())}/`
		);
		expect(parsedOmUrl).not.toContain('current_time_1H');
		expect(parsedOmUrl).toContain(
			`${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours() + 1)}00.om`
		);
	});
	test('get in-progress and replace url', async () => {
		let parsedOmUrl = `https://map-tiles.open-meteo.com/data_spatial/dwd_icon/in-progress.json?time_step=current_time_1H%&variable=temperature_2m`;
		if (parsedOmUrl.includes('.json')) {
			parsedOmUrl = await parseMetaJson(parsedOmUrl);
		}
		console.log(parsedOmUrl);
		expect(parsedOmUrl).not.toContain('in-progress');
	});
});

describe('check valid OM Urls', () => {
	test('check if some Urls are valid', () => {
		expect(
			assertOmUrlValid(
				'https://map-tiles.open-meteo.com/data_spatial/dwd_icon/2025/11/17/0600Z/2025-11-17T1300.om'
			)
		).toBe(true);

		// undefined domain
		expect(() =>
			assertOmUrlValid(
				'https://map-tiles.open-meteo.com/data_spatial/not_a_valid_domain/2025/11/17/0600Z/2025-11-17T1300.om'
			)
		).toThrowError('Invalid Domain');

		expect(() =>
			assertOmUrlValid(
				'https://map-tiles.open-meteo.com/data_spatial/dwd_icon/2024/11/17/0600Z/2025-11-17T1300.om'
			)
		).toThrowError('Model run too far in the past');
	});
});
