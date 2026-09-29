import {
	getBaseLayer,
	getConcreteDomainValue,
	isSeamlessDomain,
	resolveConcreteDomain,
	selectSeamlessLayers
} from '../domain-helpers';
import { domainOptions } from '../domains';
import { parseLeadTimeHours, replaceUrlDomain } from '../utils/parse-url';
import { describe, expect, it } from 'vitest';

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

	it('replaceUrlDomain swaps only the domain segment', () => {
		expect(replaceUrlDomain(url, 'dwd_icon_seamless', 'dwd_icon_d2')).toBe(
			'https://example.com/data_spatial/dwd_icon_d2/2025/01/01/0600Z/2025-01-03T0600.om?variable=temperature_2m'
		);
	});

	it('parseLeadTimeHours reads run and valid time from the path', () => {
		expect(parseLeadTimeHours(url)).toBe(48);
		expect(
			parseLeadTimeHours('https://example.com/data_spatial/dwd_icon/latest.json')
		).toBeUndefined();
	});
});
