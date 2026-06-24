import { GaussianGrid } from '../grids/gaussian';
import { describe, expect, test } from 'vitest';

import type { GaussianGridData, InterpolationMethod } from '../types';

// Smallest octahedral reduced-Gaussian grid: latitudeLines = 4.
// Row point counts: 20,24,28,32 (N→equator) then mirrored 32,28,24,20.
// Total points = 4 * L * (L + 9) = 4 * 4 * 13 = 208.
const L = 4;
const data: GaussianGridData = {
	type: 'gaussian',
	nx: 208,
	ny: 1,
	gaussianGridLatitudeLines: L
};

// Fill every node with a value produced by `f(lat, lon)` using the grid's own
// node coordinates, so interpolation recovers a known field.
const fill = (grid: GaussianGrid, f: (lat: number, lon: number) => number): Float32Array => {
	const values = new Float32Array(data.nx);
	grid.forEachPoint(({ index, lat, lon }) => {
		values[index] = f(lat, lon);
	});
	return values;
};

const methods: InterpolationMethod[] = ['nearest', 'linear', 'cubic', 'monotone', 'smooth'];

describe('GaussianGrid interpolation', () => {
	test('every method returns a finite value in the interior', () => {
		const grid = new GaussianGrid(data);
		const values = fill(grid, (lat) => lat);
		for (const method of methods) {
			const v = grid.getInterpolatedValue(values, 5, 12, method);
			expect(isFinite(v)).toBe(true);
		}
	});

	test('a latitude-only linear field is recovered by the blending methods', () => {
		// f = lat is linear in the (uniform) latitude index, so linear, cubic and
		// monotone reproduce it exactly. The equator sample sits exactly between
		// the two equator-adjacent rows, so the recovered value is ~0.
		const grid = new GaussianGrid(data);
		const values = fill(grid, (lat) => lat);
		for (const method of ['linear', 'cubic', 'monotone'] as InterpolationMethod[]) {
			expect(grid.getInterpolatedValue(values, 0, 33, method)).toBeCloseTo(0, 1);
		}
		// nearest snaps to the closest row (there is none on the equator), so it
		// returns one of the two adjacent row latitudes, not 0.
		expect(Math.abs(grid.getInterpolatedValue(values, 0, 33, 'nearest'))).toBeCloseTo(10.588, 1);
	});

	test("'nearest' returns an actual node value (no blending)", () => {
		const grid = new GaussianGrid(data);
		const values = fill(grid, (_lat, lon) => Math.round(lon)); // distinct-ish per node
		const present = new Set(Array.from(values));
		const v = grid.getInterpolatedValue(values, 8, 47, 'nearest');
		expect(present.has(v)).toBe(true);
	});

	test("'cubic' and 'monotone' stay within the local data range (no wild overshoot)", () => {
		const grid = new GaussianGrid(data);
		// A smooth longitudinal wave, sampled away from the ±180° seam.
		const values = fill(grid, (_lat, lon) => 10 + 5 * Math.sin((lon * Math.PI) / 180));
		for (let lon = -120; lon <= 120; lon += 3) {
			for (const method of ['cubic', 'monotone'] as InterpolationMethod[]) {
				const v = grid.getInterpolatedValue(values, 7, lon, method);
				expect(v).toBeGreaterThanOrEqual(5 - 1e-6);
				expect(v).toBeLessThanOrEqual(15 + 1e-6);
			}
		}
	});

	test("'monotone' is shape-preserving across a quantized longitudinal step", () => {
		const grid = new GaussianGrid(data);
		// step at lon 0: -1 for lon<0, +1 for lon>=0 (quantized, sharp)
		const values = fill(grid, (_lat, lon) => (lon >= 0 && lon < 180 ? 1 : -1));
		for (let lon = -90; lon <= 90; lon += 2) {
			const v = grid.getInterpolatedValue(values, -7, lon, 'monotone');
			// PCHIP must never overshoot the [-1, 1] sample range
			expect(v).toBeGreaterThanOrEqual(-1 - 1e-6);
			expect(v).toBeLessThanOrEqual(1 + 1e-6);
		}
	});
});
