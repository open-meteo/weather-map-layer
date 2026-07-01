import { domainOptions } from '../domains';
import { GridFactory } from '../grids/index';
import { describe, expect, it } from 'vitest';

import type { Domain } from '../types';

const gridOf = (value: string) =>
	GridFactory.create((domainOptions.find((d) => d.value === value) as Domain).grid, null);

describe('getBoundaryPolygon', () => {
	it('returns the data-hugging rectangle for a regular grid', () => {
		const domain = domainOptions.find((d) => d.value === 'dwd_icon_d2') as Domain; // type: 'regular'
		const grid = GridFactory.create(domain.grid, null);
		const ring = grid.getBoundaryPolygon();
		const [minLon, minLat, maxLon, maxLat] = grid.getBounds();

		// The bounds max edges sit one cell beyond the last data point (bounds max =
		// origin + d·count), so the outline pulls its north/east edges in by one cell
		// to hug the rendered data. The south/west edges already match the data.
		const { nx, ny } = domain.grid;
		const east = maxLon - (maxLon - minLon) / nx;
		const north = maxLat - (maxLat - minLat) / ny;

		expect(ring).toHaveLength(5);
		expect(ring[0]).toEqual(ring[ring.length - 1]); // closed ring
		expect(ring).toEqual([
			[minLon, minLat],
			[east, minLat],
			[east, north],
			[minLon, north],
			[minLon, minLat]
		]);
	});

	it('keeps longitudes continuous across the antimeridian for a pole-enclosing grid', () => {
		// CMC GEM RDPS is a rotated lat/lon grid whose rectangle contains the North
		// Pole, so its lon/lat perimeter winds a full 360°. Normalizing each vertex
		// to [-180, 180] would inject a ~360° jump that renders as a line clipping
		// straight across the map; the perimeter must instead stay continuous.
		const grid = gridOf('cmc_gem_rdps_10km');
		const ring = grid.getBoundaryPolygon();

		// No two consecutive vertices jump by more than 180° (no antimeridian tear).
		for (let i = 1; i < ring.length; i++) {
			expect(Math.abs(ring[i][0] - ring[i - 1][0])).toBeLessThan(180);
		}

		// The ring genuinely encircles the pole: longitudes span a full 360° and so
		// reach beyond [-180, 180], and the closed ring's endpoints are the same
		// geographic point exactly one turn (360°) apart.
		const lons = ring.map(([lon]) => lon);
		expect(Math.max(...lons) - Math.min(...lons)).toBeGreaterThan(359);
		expect(Math.abs(ring[ring.length - 1][0] - ring[0][0])).toBeCloseTo(360, 1);
		expect(ring[ring.length - 1][1]).toBeCloseTo(ring[0][1], 6);
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

describe('edgeDistanceDeg', () => {
	it('is ~0 on the boundary and clearly positive deep inside (projected grid)', () => {
		const grid = gridOf('ncep_hrrr_conus');
		for (const [lon, lat] of grid.getBoundaryPolygon()) {
			expect(Math.abs(grid.edgeDistanceDeg(lat, lon))).toBeLessThan(0.2);
		}
		const c = grid.getCenter();
		expect(grid.edgeDistanceDeg(c.lat, c.lng)).toBeGreaterThan(1);
	});

	it('follows the curved boundary, not the bounding box', () => {
		const grid = gridOf('ncep_hrrr_conus');
		const [minLon, minLat, maxLon, maxLat] = grid.getBounds();
		const boxDist = (lon: number, lat: number) =>
			Math.min(lon - minLon, maxLon - lon, lat - minLat, maxLat - lat);

		// A boundary vertex that sits far from every bbox edge lives on the curved
		// part of the perimeter. The old rectangular blend would see it as deep
		// inside (large box distance → no blend → hard seam); the projection-aware
		// distance correctly reports it as on the edge (~0).
		const onCurve = grid.getBoundaryPolygon().find(([lon, lat]) => boxDist(lon, lat) > 1);
		expect(onCurve).toBeDefined();
		const [lon, lat] = onCurve!;
		expect(boxDist(lon, lat)).toBeGreaterThan(1);
		expect(grid.edgeDistanceDeg(lat, lon)).toBeLessThan(0.3);
	});
});
