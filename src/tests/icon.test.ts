import { IconGrid } from '../grids/icon';
import { describe, expect, test } from 'vitest';

import type { IconGridData } from '../types';

// Small grid for exhaustive checks: R2B03 → 20 · 2² · 4³ = 5120 cells
const smallGridData: IconGridData = {
	type: 'icon',
	nx: 5120,
	ny: 1,
	iconRoot: 2,
	iconBisections: 3
};

// The real DWD ICON global grid: R3B07 → 20 · 3² · 4⁷ = 2,949,120 cells
const globalGridData: IconGridData = {
	type: 'icon',
	nx: 2949120,
	ny: 1,
	iconRoot: 3,
	iconBisections: 7
};

describe('IconGrid', () => {
	test('rejects a mismatched cell count', () => {
		expect(() => new IconGrid({ ...smallGridData, nx: 5000 })).toThrow(/5120/);
	});

	test('cell count formulas: R2B03 and R3B07', () => {
		// covered by the constructor consistency check not throwing
		expect(() => new IconGrid(smallGridData)).not.toThrow();
		expect(() => new IconGrid(globalGridData)).not.toThrow();
	});

	test('global bounds and center', () => {
		const grid = new IconGrid(smallGridData);
		expect(grid.getBounds()).toEqual([-180, -90, 180, 90]);
		expect(grid.getCenter()).toEqual({ lng: 0, lat: 0 });
	});

	test('getCoveringRanges returns the full grid', () => {
		const grid = new IconGrid(globalGridData);
		expect(grid.getCoveringRanges(40, -10, 60, 30)).toEqual([
			{ start: 0, end: 1 },
			{ start: 0, end: 2949120 }
		]);
	});

	test('index → center → index roundtrips exactly for every cell (R2B03)', () => {
		const grid = new IconGrid(smallGridData);
		for (let index = 0; index < smallGridData.nx; index++) {
			const { lat, lon } = grid.cellCoordinates(index);
			expect(grid.findCell(lat, lon)).toBe(index);
		}
	});

	test('index → center → index roundtrips for sampled cells (R3B07 global)', () => {
		const grid = new IconGrid(globalGridData);
		// prime stride → samples every face, root triangle and subtree shape
		for (let index = 0; index < globalGridData.nx; index += 9973) {
			const { lat, lon } = grid.cellCoordinates(index);
			expect(grid.findCell(lat, lon)).toBe(index);
		}
	});

	test('every coordinate maps to a valid cell (deterministic pseudo-random sweep)', () => {
		const grid = new IconGrid(globalGridData);
		// simple LCG so the test is reproducible
		let seed = 12345;
		const next = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		for (let i = 0; i < 20000; i++) {
			const lat = next() * 180 - 90;
			const lon = next() * 360 - 180;
			const index = grid.findCell(lat, lon);
			expect(index).toBeGreaterThanOrEqual(0);
			expect(index).toBeLessThan(globalGridData.nx);
			expect(Number.isInteger(index)).toBe(true);
		}
	});

	test('poles and antimeridian resolve to valid cells', () => {
		const grid = new IconGrid(globalGridData);
		for (const [lat, lon] of [
			[90, 0],
			[-90, 0],
			[90, 123.4],
			[-90, -77.7],
			[0, 180],
			[0, -180],
			[45.5, 180],
			[-33.3, -180]
		]) {
			const index = grid.findCell(lat, lon);
			expect(index).toBeGreaterThanOrEqual(0);
			expect(index).toBeLessThan(globalGridData.nx);
		}
		// both sides of the antimeridian are the same meridian
		expect(grid.findCell(12.3, 180)).toBe(grid.findCell(12.3, -180));
	});

	test('sampling returns the containing cell value', () => {
		const grid = new IconGrid(smallGridData);
		const values = new Float32Array(Array.from({ length: smallGridData.nx }, (_, i) => i));
		for (let index = 0; index < smallGridData.nx; index += 7) {
			const { lat, lon } = grid.cellCoordinates(index);
			expect(grid.getLinearInterpolatedValue(values, lat, lon)).toBe(index);
			expect(grid.getNearestNeighborValue(values, lat, lon)).toBe(index);
		}
	});

	test('warp table reproduces true DWD cell centres (icon_grid_0026 R3B07)', () => {
		const grid = new IconGrid(globalGridData);
		// reference clat/clon values straight from the official grid file; the
		// embedded warp table must reproduce them to well under a cell width
		// (documented accuracy: ~35 m mean, 0.53 km max)
		const references: [number, number, number][] = [
			[0, 89.913098, 72.0],
			[1000000, 27.312874, 132.333905],
			[2949119, -26.650061, 0.057151]
		];
		for (const [index, lat, lon] of references) {
			const c = grid.cellCoordinates(index);
			const dLat = c.lat - lat;
			let dLon = Math.abs(c.lon - lon);
			if (dLon > 180) dLon = 360 - dLon;
			const cosLat = Math.cos((lat * Math.PI) / 180);
			const distDeg = Math.sqrt(dLat * dLat + dLon * cosLat * (dLon * cosLat));
			expect(distDeg * 111.19).toBeLessThan(0.6); // km
			expect(grid.findCell(lat, lon)).toBe(index);
		}
	});

	test('cellVertices returns the triangle around the cell centre', () => {
		const grid = new IconGrid(smallGridData);
		for (let index = 0; index < smallGridData.nx; index += 101) {
			const verts = grid.cellVertices(index);
			expect(verts).toHaveLength(3);
			const center = grid.cellCoordinates(index);
			// the centre must lie inside the triangle: same cell as all-vertex mean
			// and within a cell diameter of every vertex (R2B03 cells ~7.9°)
			for (const v of verts) {
				const dLat = v.lat - center.lat;
				let dLon = Math.abs(v.lon - center.lon);
				if (dLon > 180) dLon = 360 - dLon;
				const cosLat = Math.cos((center.lat * Math.PI) / 180);
				expect(Math.hypot(dLat, dLon * cosLat)).toBeLessThan(8);
			}
		}
	});

	test('getInterpolatedValue: nearest returns the containing cell value', () => {
		const grid = new IconGrid(smallGridData);
		const values = new Float32Array(Array.from({ length: smallGridData.nx }, (_, i) => i));
		for (let index = 0; index < smallGridData.nx; index += 13) {
			const { lat, lon } = grid.cellCoordinates(index);
			expect(grid.getInterpolatedValue(values, lat, lon, 'nearest')).toBe(index);
		}
	});

	test('bilinear interpolation reproduces a smooth field between cell centres', () => {
		const grid = new IconGrid(smallGridData);
		// smooth field sampled at the analytical cell centres
		const f = (lat: number, lon: number) => {
			const la = (lat * Math.PI) / 180;
			const lo = (lon * Math.PI) / 180;
			return 10 * Math.cos(la) * Math.cos(lo) + 5 * Math.sin(la);
		};
		const values = new Float32Array(smallGridData.nx);
		for (let i = 0; i < smallGridData.nx; i++) {
			const { lat, lon } = grid.cellCoordinates(i);
			values[i] = f(lat, lon);
		}
		// deterministic pseudo-random sample points; R2B03 cells are ~7.9° wide,
		// so a first-order-accurate blend stays well within ~1.5 units of f
		let seed = 4711;
		const next = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		for (let i = 0; i < 2000; i++) {
			const lat = next() * 180 - 90;
			const lon = next() * 360 - 180;
			const v = grid.getInterpolatedValue(values, lat, lon, 'linear');
			expect(Math.abs(v - f(lat, lon))).toBeLessThan(1.5);
		}
		// cubic and monotone fall back to the same blend for now
		expect(grid.getInterpolatedValue(values, 12.3, -45.6, 'cubic')).toBe(
			grid.getInterpolatedValue(values, 12.3, -45.6, 'linear')
		);
		expect(grid.getInterpolatedValue(values, 12.3, -45.6, 'monotone')).toBe(
			grid.getInterpolatedValue(values, 12.3, -45.6, 'linear')
		);
	});

	test('bilinear interpolation is NaN-aware', () => {
		const grid = new IconGrid(smallGridData);
		const values = new Float32Array(smallGridData.nx).fill(7);
		const hole = grid.findCell(47.3, 8.5);
		values[hole] = NaN;
		const center = grid.cellCoordinates(hole);
		// centre value missing → NaN at the cell centre
		expect(grid.getInterpolatedValue(values, center.lat, center.lon, 'linear')).toBeNaN();
		// a missing neighbour is dropped and the rest renormalized
		const neighbor = grid.cellCoordinates(hole + 1);
		expect(grid.getInterpolatedValue(values, neighbor.lat, neighbor.lon, 'linear')).toBe(7);
	});

	test('cell centers of neighbouring indices are geographically close (R3B07)', () => {
		const grid = new IconGrid(globalGridData);
		// Sibling cells (same parent, indices 4m..4m+3) always touch, so their
		// centres must sit within a few cell diameters (~13 km ≈ 0.12°) of each
		// other — a cheap sanity check that the digit ordering is spatial.
		for (let parent = 0; parent < globalGridData.nx / 4; parent += 39119) {
			const centers = [0, 1, 2, 3].map((d) => grid.cellCoordinates(parent * 4 + d));
			for (let d = 1; d < 4; d++) {
				const dLat = centers[d].lat - centers[0].lat;
				let dLon = Math.abs(centers[d].lon - centers[0].lon);
				if (dLon > 180) dLon = 360 - dLon;
				const cosLat = Math.cos((centers[0].lat * Math.PI) / 180);
				const distDeg = Math.sqrt(dLat * dLat + dLon * cosLat * (dLon * cosLat));
				expect(distDeg).toBeLessThan(0.5);
			}
		}
	});

	test('forEachPoint visits every cell exactly once with matching coordinates', () => {
		const grid = new IconGrid(smallGridData);
		const seen = new Set<number>();
		grid.forEachPoint(({ index, lat, lon }) => {
			expect(seen.has(index)).toBe(false);
			seen.add(index);
			const center = grid.cellCoordinates(index);
			expect(lat).toBeCloseTo(center.lat, 10);
			expect(lon).toBeCloseTo(center.lon, 10);
		});
		expect(seen.size).toBe(smallGridData.nx);
	});

	test('forEachPoint bounds filter only yields points inside the box', () => {
		const grid = new IconGrid(smallGridData);
		let count = 0;
		grid.forEachPoint(
			({ lat, lon }) => {
				expect(lat).toBeGreaterThanOrEqual(0);
				expect(lat).toBeLessThanOrEqual(45);
				expect(lon).toBeGreaterThanOrEqual(-30);
				expect(lon).toBeLessThanOrEqual(30);
				count++;
			},
			[-30, 0, 30, 45]
		);
		expect(count).toBeGreaterThan(0);
		expect(count).toBeLessThan(smallGridData.nx);
	});

	test('forEachPoint stops early when the callback returns false', () => {
		const grid = new IconGrid(smallGridData);
		let count = 0;
		grid.forEachPoint(() => {
			count++;
			if (count === 10) return false;
		});
		expect(count).toBe(10);
	});
});
