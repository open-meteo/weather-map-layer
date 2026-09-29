import {
	getBaseLayer,
	getConcreteDomainValue,
	isSeamlessDomain,
	resolveConcreteDomain,
	selectSeamlessLayers
} from '../domain-helpers';
import { domainOptions } from '../domains';
import { normalizeUrl, parseLeadTimeHours, replaceUrlDomain } from '../utils/parse-url';
import { describe, expect, it, vi } from 'vitest';

import type { SeamlessDomain } from '../types';

const seamless = domainOptions.find((d) => d.value === 'dwd_icon_seamless') as SeamlessDomain;
const layerValues = (filter: Parameters<typeof selectSeamlessLayers>[2]) =>
	selectSeamlessLayers(seamless, domainOptions, filter).map(({ domain }) => domain.value);

describe('domain helpers', () => {
	it('tells composites apart from concrete domains', () => {
		expect(isSeamlessDomain(seamless)).toBe(true);
		expect(isSeamlessDomain(domainOptions.find((d) => d.value === 'dwd_icon')!)).toBe(false);
	});

	it('a composite is represented by its base layer, a domain by itself', () => {
		expect(getBaseLayer(seamless).domainValue).toBe('dwd_icon');
		expect(getConcreteDomainValue(seamless)).toBe('dwd_icon');
		const d2 = domainOptions.find((d) => d.value === 'dwd_icon_d2')!;
		expect(getConcreteDomainValue(d2)).toBe('dwd_icon_d2');
	});

	it('a composite shares the grid and cadence of its base layer', () => {
		for (const composite of domainOptions.filter(isSeamlessDomain)) {
			const base = resolveConcreteDomain(getConcreteDomainValue(composite), domainOptions);
			expect(composite.grid).toBe(base?.grid);
			expect(composite.time_interval).toBe(base?.time_interval);
			expect(composite.model_interval).toBe(base?.model_interval);
		}
	});

	it('every layer of every composite names a concrete domain, finest-first, ending at zoom 0', () => {
		for (const composite of domainOptions.filter(isSeamlessDomain)) {
			const resolved = selectSeamlessLayers(composite, domainOptions).map(({ layer }) => layer);
			expect(resolved).toEqual(composite.layers);
			const zooms = composite.layers.map((layer) => layer.minZoom);
			expect(zooms).toEqual([...zooms].sort((a, b) => b - a));
			expect(zooms[zooms.length - 1]).toBe(0);
		}
	});
});

describe('selectSeamlessLayers', () => {
	it('returns every layer, finest-first, without a filter', () => {
		expect(layerValues({})).toEqual(['dwd_icon_d2', 'dwd_icon_eu', 'dwd_icon']);
	});

	it('leaves out layers above the zoom', () => {
		expect(layerValues({ zoom: 2 })).toEqual(['dwd_icon_eu', 'dwd_icon']);
		expect(layerValues({ zoom: 0 })).toEqual(['dwd_icon']);
	});

	it('leaves out finer layers outside the viewport, never the base one', () => {
		expect(layerValues({ viewportBounds: [-120, 30, -100, 45] })).toEqual(['dwd_icon']);
		expect(layerValues({ viewportBounds: [5, 47, 15, 55] })).toEqual([
			'dwd_icon_d2',
			'dwd_icon_eu',
			'dwd_icon'
		]);
	});

	it('leaves out layers past their forecast horizon', () => {
		expect(layerValues({ leadTimeHours: 47 })).toEqual(['dwd_icon_d2', 'dwd_icon_eu', 'dwd_icon']);
		expect(layerValues({ leadTimeHours: 49 })).toEqual(['dwd_icon_eu', 'dwd_icon']);
		expect(layerValues({ leadTimeHours: 121 })).toEqual(['dwd_icon']);
	});
});

describe('url helpers', () => {
	const url =
		'https://example.com/data_spatial/dwd_icon_seamless/2025/01/01/0600Z/2025-01-03T0600.om?variable=temperature_2m';

	it('replaceUrlDomain swaps the domain segment wherever the path puts it', () => {
		expect(replaceUrlDomain(url, 'dwd_icon_seamless', 'dwd_icon_d2')).toBe(
			'https://example.com/data_spatial/dwd_icon_d2/2025/01/01/0600Z/2025-01-03T0600.om?variable=temperature_2m'
		);
		// Without a data_spatial prefix, for a bare file and for metadata.
		expect(
			replaceUrlDomain(
				'https://example.com/dwd_icon_seamless/2025/01/01/0600Z/2025-01-03T0600.om',
				'dwd_icon_seamless',
				'dwd_icon'
			)
		).toBe('https://example.com/dwd_icon/2025/01/01/0600Z/2025-01-03T0600.om');
		expect(
			replaceUrlDomain(
				'https://example.com/dwd_icon_seamless/file.om',
				'dwd_icon_seamless',
				'dwd_icon'
			)
		).toBe('https://example.com/dwd_icon/file.om');
		expect(
			replaceUrlDomain(
				'https://example.com/dwd_icon_seamless/latest.json',
				'dwd_icon_seamless',
				'dwd_icon'
			)
		).toBe('https://example.com/dwd_icon/latest.json');
		// Another domain's URL is left alone.
		expect(
			replaceUrlDomain('https://example.com/dwd_icon/file.om', 'dwd_icon_seamless', 'dwd_icon_d2')
		).toBe('https://example.com/dwd_icon/file.om');
	});

	it('parseLeadTimeHours reads run and valid time from the path', () => {
		expect(parseLeadTimeHours(url)).toBe(48);
		expect(
			parseLeadTimeHours('https://example.com/data_spatial/dwd_icon/latest.json')
		).toBeUndefined();
	});

	it('normalizeUrl resolves a composite {meta}.json through its base layer', async () => {
		const fetched: string[] = [];
		vi.stubGlobal('fetch', async (url: string) => {
			fetched.push(url);
			return {
				ok: true,
				json: async () => ({
					reference_time: '2025-01-01T00:00:00Z',
					valid_times: ['2025-01-01T00:00Z']
				})
			};
		});
		try {
			const resolved = await normalizeUrl(
				'om://https://example.com/data_spatial/dwd_icon_seamless/latest.json?variable=temperature_2m',
				domainOptions
			);
			// The server only knows concrete domains, but the resolved URL keeps the
			// composite so the protocol can fan it out per layer.
			expect(fetched).toEqual(['https://example.com/data_spatial/dwd_icon/latest.json']);
			expect(resolved).toContain('/dwd_icon_seamless/2025/01/01/0000Z/2025-01-01T0000.om');
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
