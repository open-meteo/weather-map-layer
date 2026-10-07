import { domainOptions } from '../domains';
import { domainMaxZoom, gridMaxZoom, gridResolutionZoom, gridSpacing } from '../grids/max-zoom';
import { describe, expect, it } from 'vitest';

import type { Domain, GridData } from '../types';

const grid = (value: string): GridData => domainOptions.find((d) => d.value === value)!.grid;
const domain = (value: string): Domain => domainOptions.find((d) => d.value === value)!;

describe('gridSpacing', () => {
	it('takes regular spacing as is, ignoring a flipped sign', () => {
		expect(gridSpacing(grid('dwd_icon_d2'), 50)).toEqual({ lon: 0.02, lat: 0.02 });
		expect(gridSpacing(grid('cams_europe'), 50)).toEqual({ lon: 0.1, lat: 0.1 });
	});

	it('converts metres to degrees at the centre latitude for projected grids', () => {
		const spacing = gridSpacing(grid('ukmo_uk_deterministic_2km'), 55);
		expect(spacing.lat).toBeCloseTo(2000 / 111320, 6);
		expect(spacing.lon).toBeCloseTo(2000 / (111320 * Math.cos((55 * Math.PI) / 180)), 6);
	});

	it('keeps degrees for rotated lat/lon grids', () => {
		expect(gridSpacing(grid('meteoswiss_icon_ch1'), 47)).toEqual({ lon: 0.01, lat: 0.01 });
	});

	it('derives Gaussian spacing from the latitude lines', () => {
		const spacing = gridSpacing(grid('ecmwf_ifs'), 0);
		expect(spacing.lat).toBeCloseTo(90 / 1280, 6);
		expect(spacing.lon).toBeCloseTo(360 / 5120, 6);
	});
});

describe('gridResolutionZoom', () => {
	it('is the first zoom whose tile pixel is finer than the spacing', () => {
		// 0.25°: a zoom 2 tile pixel spans 0.176°
		expect(gridResolutionZoom(grid('ecmwf_ifs025'))).toBe(2);
		// 0.125°
		expect(gridResolutionZoom(grid('dwd_icon'))).toBe(3);
		// 0.02° at 50° N
		expect(gridResolutionZoom(grid('dwd_icon_d2'))).toBe(6);
		// 0.01° at 45° N
		expect(gridResolutionZoom(grid('meteofrance_arome_france_hd'))).toBe(7);
	});
});

describe('gridMaxZoom / domainMaxZoom', () => {
	it('is one past the resolution zoom, capped at the protocol maximum', () => {
		expect(gridMaxZoom(grid('ecmwf_ifs025'))).toBe(3);
		expect(gridMaxZoom(grid('meteofrance_arome_france_hd'))).toBe(8);
		expect(
			gridMaxZoom({
				type: 'regular',
				nx: 100,
				ny: 100,
				latMin: 0,
				lonMin: 0,
				dx: 0.0001,
				dy: 0.0001
			})
		).toBe(12);
	});

	it('never exceeds the protocol maximum for any domain', () => {
		for (const d of domainOptions) {
			const zoom = domainMaxZoom(d, domainOptions);
			expect(zoom, d.value).toBeGreaterThanOrEqual(1);
			expect(zoom, d.value).toBeLessThanOrEqual(12);
		}
	});

	it('takes the finest layer of a composite', () => {
		const seamless = domainOptions.find((d) => 'type' in d && d.type === 'seamless')!;
		const layers = (seamless as Domain & { layers: { domainValue: string }[] }).layers;
		const finest = Math.max(...layers.map((l) => gridMaxZoom(grid(l.domainValue))));
		expect(domainMaxZoom(seamless, domainOptions)).toBe(finest);
		expect(domainMaxZoom(domain('dwd_icon'), domainOptions)).toBe(gridMaxZoom(grid('dwd_icon')));
	});
});
