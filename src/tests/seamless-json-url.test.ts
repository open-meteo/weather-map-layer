import { domainOptions } from '../domains';
import { resolveJsonFetchUrl } from '../utils/parse-url';
import { describe, expect, it } from 'vitest';

// Regression test: the meta-JSON fetch for a seamless composite domain must be
// rewritten to the global backing domain — the server only serves meta files
// for concrete domains. This broke when RESOLVE_DOMAIN_REGEX started requiring
// a ".om" suffix (which meta-JSON URLs never have), leaving the seamless URL
// unrewritten and 404ing.
describe('resolveJsonFetchUrl', () => {
	it('rewrites a seamless latest.json to its global backing domain', () => {
		expect(
			resolveJsonFetchUrl(
				'https://map-tiles.open-meteo.com/data_spatial/dwd_icon_seamless/latest.json',
				domainOptions
			)
		).toBe('https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json');
	});

	it('rewrites in-progress.json the same way', () => {
		expect(
			resolveJsonFetchUrl(
				'https://map-tiles.open-meteo.com/data_spatial/ncep_gfs_seamless/in-progress.json',
				domainOptions
			)
		).toBe('https://map-tiles.open-meteo.com/data_spatial/ncep_gfs025/in-progress.json');
	});

	it('works for endpoints without a data_spatial prefix', () => {
		expect(
			resolveJsonFetchUrl('https://cdn.example.com/dwd_icon_seamless/latest.json', domainOptions)
		).toBe('https://cdn.example.com/dwd_icon/latest.json');
	});

	it('leaves concrete-domain URLs untouched', () => {
		const url = 'https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json';
		expect(resolveJsonFetchUrl(url, domainOptions)).toBe(url);
	});

	it('leaves URLs untouched without domain options', () => {
		const url = 'https://map-tiles.open-meteo.com/data_spatial/dwd_icon_seamless/latest.json';
		expect(resolveJsonFetchUrl(url)).toBe(url);
	});
});
