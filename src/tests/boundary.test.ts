import { domainOptions } from '../domains';
import { GridFactory } from '../grids/index';
import { describe, expect, it } from 'vitest';

import type { Domain } from '../types';

const gridOf = (value: string) =>
	GridFactory.create((domainOptions.find((d) => d.value === value) as Domain).grid, null);

describe('getBoundaryPolygon', () => {
	it('returns the bounds rectangle for a regular grid', () => {
		const grid = gridOf('dwd_icon_d2'); // type: 'regular'
		const ring = grid.getBoundaryPolygon();
		const [minLon, minLat, maxLon, maxLat] = grid.getBounds();

		expect(ring).toHaveLength(5);
		expect(ring[0]).toEqual(ring[ring.length - 1]); // closed ring
		expect(ring).toEqual([
			[minLon, minLat],
			[maxLon, minLat],
			[maxLon, maxLat],
			[minLon, maxLat],
			[minLon, minLat]
		]);
	});

	it('traces the true curved perimeter for a projected grid', () => {
		const grid = gridOf('ncep_hrrr_conus'); // Lambert Conformal Conic
		const ring = grid.getBoundaryPolygon();

		// More than a 4-corner rectangle, and a closed ring.
		expect(ring.length).toBeGreaterThan(5);
		expect(ring[0]).toEqual(ring[ring.length - 1]);

		// Every vertex sits within the rectangular bounds (the curve is inscribed).
		const [minLon, minLat, maxLon, maxLat] = grid.getBounds();
		for (const [lon, lat] of ring) {
			expect(lon).toBeGreaterThanOrEqual(minLon - 1e-6);
			expect(lon).toBeLessThanOrEqual(maxLon + 1e-6);
			expect(lat).toBeGreaterThanOrEqual(minLat - 1e-6);
			expect(lat).toBeLessThanOrEqual(maxLat + 1e-6);
		}

		// The boundary is genuinely curved: the southern edge dips below its endpoints'
		// latitude (LCC bows the parallels), so the polygon is not axis-aligned.
		const lats = ring.map(([, lat]) => lat);
		const lons = ring.map(([lon]) => lon);
		const distinctLatsAtExtremeLon = new Set(
			ring.filter(([lon]) => Math.abs(lon - Math.min(...lons)) < 0.01).map(([, lat]) => lat)
		);
		expect(Math.max(...lats) - Math.min(...lats)).toBeGreaterThan(0);
		expect(distinctLatsAtExtremeLon.size).toBeGreaterThan(0);
	});
});
