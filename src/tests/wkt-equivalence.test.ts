import { domainOptions } from '../domains';
import { GridFactory } from '../grids/index';
import { wktToGridData } from '../utils/wkt';
import { describe, expect, test } from 'vitest';

import crsWkt from './fixtures/crs-wkt.json';

import type { Domain } from '../types';

/**
 * Every concrete domain in the catalogue must be reproducible from the
 * `crs_wkt` string the server publishes for it, otherwise a file-derived grid
 * would place data differently from the hand-written one.
 *
 * The fixture holds the `crs_wkt` of each domain's
 * `https://map-tiles.open-meteo.com/data_spatial/<domain>/latest.json` (grids
 * do not change between runs). Add the string when adding a domain.
 */
const fixtures: Record<string, string> = crsWkt;

/** Catalogue entries without data_spatial output as of 2026-09-09. */
const UNSERVED = new Set(['ncep_gfs_graphcast025', 'kma_gdps', 'ecmwf_ec46_ensemble_mean']);

const concreteDomains = domainOptions.filter((d): d is Domain => 'grid' in d && !!d.grid);

// Grid values equal to their own index, so a nearest-neighbour lookup returns
// the cell index and two grids agree exactly when they place a point in the
// same cell. Shared across domains; every grid uses a prefix of it.
let indexValues = new Float32Array(0);
const indices = (n: number): Float32Array => {
	if (indexValues.length < n) {
		indexValues = new Float32Array(n);
		for (let i = 0; i < n; i++) indexValues[i] = i;
	}
	return indexValues.subarray(0, n);
};

describe('wktToGridData reproduces the catalogue grids', () => {
	test('every served domain has a fixture', () => {
		const missing = concreteDomains
			.filter((d) => !fixtures[d.value] && !UNSERVED.has(d.value))
			.map((d) => d.value);
		expect(missing).toEqual([]);
	});

	for (const domain of concreteDomains) {
		const wkt = fixtures[domain.value];
		if (!wkt) continue;

		test(domain.value, () => {
			const derived = wktToGridData(wkt, domain.grid.nx, domain.grid.ny);
			const expected = GridFactory.create(domain.grid, null);
			const actual = GridFactory.create(derived, null);

			// The server writes float32 corner coordinates, so allow ~1e-4°.
			const expectedBounds = expected.getBounds();
			actual.getBounds().forEach((v, i) => expect(v).toBeCloseTo(expectedBounds[i], 3));

			if (domain.grid.type === 'gaussian') {
				expect(derived).toMatchObject({
					type: 'gaussian',
					gaussianGridLatitudeLines: domain.grid.gaussianGridLatitudeLines
				});
				return;
			}

			// Nearest-cell agreement on a lattice of interior points. The odd
			// fractions keep the samples off cell edges, where a rounding
			// difference in the last digit would flip the index legitimately.
			const values = indices(domain.grid.nx * domain.grid.ny);
			const [west, south, east, north] = expectedBounds;
			const steps = 7;
			let checked = 0;
			const mismatches: string[] = [];
			for (let yi = 0; yi < steps; yi++) {
				for (let xi = 0; xi < steps; xi++) {
					const lat = south + (north - south) * (0.0317 + (0.9371 * yi) / (steps - 1));
					const lon = west + (east - west) * (0.0317 + (0.9371 * xi) / (steps - 1));
					const expectedIndex = expected.getInterpolatedValue(values, lat, lon, 'nearest');
					if (!isFinite(expectedIndex)) continue;
					checked++;
					const actualIndex = actual.getInterpolatedValue(values, lat, lon, 'nearest');
					if (actualIndex !== expectedIndex) {
						mismatches.push(
							`(${lat.toFixed(3)}, ${lon.toFixed(3)}): ${expectedIndex} vs ${actualIndex}`
						);
					}
				}
			}
			expect(checked).toBeGreaterThan(0);
			expect(mismatches).toEqual([]);
		});
	}
});
