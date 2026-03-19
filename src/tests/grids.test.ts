import { domainOptions } from '../domains';
import { ProjectionGrid } from '../grids/projected';
import { LambertConformalConicProjection, RotatedLatLonProjection } from '../grids/projections';
import { RegularGrid } from '../grids/regular';
import { describe, expect, test } from 'vitest';

import type {
	AnyProjectionGridData,
	DimensionRange,
	LCCProjectionData,
	ProjectionGridFromGeographicOrigin,
	RegularGridData,
	RotatedLatLonProjectionData
} from '../types';

const dmiDomain = domainOptions.find((d) => d.value === 'dmi_harmonie_arome_europe');
const knmiDomain = domainOptions.find((d) => d.value === 'knmi_harmonie_arome_europe');

test('Test LambertConformalConicProjection for DMI', () => {
	const projectedGrid = dmiDomain?.grid as AnyProjectionGridData;
	const lccProjectionData = projectedGrid.projection as LCCProjectionData;
	const proj = new LambertConformalConicProjection(lccProjectionData);
	expect(proj.ρ0).toBe(0.6872809586016131);
	expect(proj.F).toBe(1.801897704650192);
	expect(proj.n).toBe(0.8241261886220157);
	expect(proj.λ0).toBe(-0.13962634015954636);
	expect(proj.R).toBe(6371229);

	expect(proj.forward(39.671, -25.421997)[0]).toBe(-1527524.6244234492);
	expect(proj.forward(39.671, -25.421997)[1]).toBe(-1588681.0428292789);

	expect(proj.reverse(-1527524.6244234492, -1588681.0428292789)[0]).toBe(39.671000000000014);
	expect(proj.reverse(-1527524.6244234492, -1588681.0428292789)[1]).toBe(-25.421996999999998);
});

test('Test RotatedLatLon for KNMI', () => {
	const projectedGrid = knmiDomain?.grid as AnyProjectionGridData;
	const rotatedLatLonProjectionData = projectedGrid.projection as RotatedLatLonProjectionData;
	const proj = new RotatedLatLonProjection(rotatedLatLonProjectionData);
	expect(proj.θ).toBe(0.9599310885968813);
	expect(proj.ϕ).toBe(-0.13962634015954636);

	expect(proj.forward(39.671, -25.421997)[0]).toBe(13.716985366241445);
	expect(proj.forward(39.671, -25.421997)[1]).toBe(13.617348599940314);
});

// Example grid data
const gridData: RegularGridData = {
	type: 'regular',
	nx: 10,
	ny: 3,
	lonMin: 10,
	latMin: 50,
	dx: 1,
	dy: 2
};

// Same geographic area as gridData, but with negative dy (north-to-south row order)
// Row 0 is at lat 56 (top), row 1 at lat 54, row 2 at lat 52 (bottom)
const gridDataNegDy: RegularGridData = {
	type: 'regular',
	nx: 10,
	ny: 3,
	lonMin: 10,
	latMin: 56,
	dx: 1,
	dy: -2
};

const projectedGridData: ProjectionGridFromGeographicOrigin = {
	type: 'projectedFromGeographicOrigin',
	nx: 10,
	ny: 10,
	latitude: 50,
	longitude: 10,
	dx: 10000,
	dy: 10000,
	projection: {
		λ0: 10,
		ϕ0: 50,
		ϕ1: 50,
		ϕ2: 50,
		radius: 6371229,
		name: 'LambertConformalConicProjection'
	}
};

describe('RegularGrid', () => {
	test('constructs and computes bounds', () => {
		const grid = new RegularGrid(gridData);
		expect(grid.getBounds()).toEqual([10, 50, 20, 56]);
	});

	test('construct a new partial grid', () => {
		const ranges: DimensionRange[] = [
			{ start: 0, end: 3 },
			{ start: 0, end: 4 }
		];
		const grid = new RegularGrid(gridData, ranges);
		expect(grid.getBounds()).toEqual([10, 50, 14, 56]);
	});

	test('computes center', () => {
		const grid = new RegularGrid(gridData);
		const center = grid.getCenter();
		expect(center.lng).toBe(15);
		expect(center.lat).toBe(53);
	});

	test('computes center on partial grid', () => {
		const ranges: DimensionRange[] = [
			{ start: 0, end: 3 },
			{ start: 0, end: 4 }
		];
		const grid = new RegularGrid(gridData, ranges);
		const center = grid.getCenter();
		expect(center.lng).toBe(12);
		expect(center.lat).toBe(53);
	});

	test('linear interpolation at grid point', () => {
		const grid = new RegularGrid(gridData);
		const values = new Float32Array(Array.from({ length: 30 }, (_, index) => index));
		// At (lat=52, lon=11), should be row 1, col 1 => index 11, value 11
		expect(grid.getLinearInterpolatedValue(values, 52, 11)).toBe(11);
	});

	test('linear interpolation between grid points', () => {
		const grid = new RegularGrid(gridData);
		const values = new Float32Array(Array.from({ length: 30 }, (_, index) => index));
		// Between (52, 11) and (52, 12): should interpolate between index 11 and 12
		const interpolated = grid.getLinearInterpolatedValue(values, 52, 11.5);
		expect(interpolated).toBeCloseTo(11.5);
	});

	test('returns NaN for out-of-bounds', () => {
		const grid = new RegularGrid(gridData);
		const values = new Float32Array(Array.from({ length: 30 }, (_, index) => index));
		expect(grid.getLinearInterpolatedValue(values, 100, 100)).toBeNaN();
	});

	describe('RegularGrid with negative dy', () => {
		test('constructs and computes bounds (normalized min <= max)', () => {
			const grid = new RegularGrid(gridDataNegDy);
			// Bounds should be normalized: [minLon, minLat, maxLon, maxLat]
			expect(grid.getBounds()).toEqual([10, 50, 20, 56]);
		});

		test('construct a new partial grid with negative dy', () => {
			const ranges: DimensionRange[] = [
				{ start: 0, end: 3 },
				{ start: 0, end: 4 }
			];
			const grid = new RegularGrid(gridDataNegDy, ranges);
			expect(grid.getBounds()).toEqual([10, 50, 14, 56]);
		});

		test('computes center with negative dy', () => {
			const grid = new RegularGrid(gridDataNegDy);
			const center = grid.getCenter();
			expect(center.lng).toBe(15);
			expect(center.lat).toBe(53);
		});

		test('computes center on partial grid with negative dy', () => {
			const ranges: DimensionRange[] = [
				{ start: 0, end: 3 },
				{ start: 0, end: 4 }
			];
			const grid = new RegularGrid(gridDataNegDy, ranges);
			const center = grid.getCenter();
			expect(center.lng).toBe(12);
			expect(center.lat).toBe(53);
		});

		test('linear interpolation at grid point with negative dy', () => {
			const grid = new RegularGrid(gridDataNegDy);
			const values = new Float32Array(Array.from({ length: 30 }, (_, index) => index));
			// With negative dy: row 0 at lat=56, row 1 at lat=54, row 2 at lat=52
			// At (lat=54, lon=11): row 1, col 1 => index 11, value 11
			expect(grid.getLinearInterpolatedValue(values, 54, 11)).toBe(11);
		});

		test('linear interpolation between grid points with negative dy', () => {
			const grid = new RegularGrid(gridDataNegDy);
			const values = new Float32Array(Array.from({ length: 30 }, (_, index) => index));
			// Between lat=54 (row 1) and lat=52 (row 2), at lon=11.5 (between col 1 and 2)
			// yRaw = (53 - 56) / (-2) = 1.5, xRaw = (11.5 - 10) / 1 = 1.5
			// Bilinear interpolation of values 11, 12, 21, 22 with both fractions 0.5
			const interpolated = grid.getLinearInterpolatedValue(values, 53, 11.5);
			expect(interpolated).toBeCloseTo(16.5);
		});

		test('linear interpolation in x only with negative dy', () => {
			const grid = new RegularGrid(gridDataNegDy);
			const values = new Float32Array(Array.from({ length: 30 }, (_, index) => index));
			// At lat=54 (exactly row 1), between lon=11 and lon=12
			const interpolated = grid.getLinearInterpolatedValue(values, 54, 11.5);
			expect(interpolated).toBeCloseTo(11.5);
		});

		test('returns NaN for out-of-bounds with negative dy', () => {
			const grid = new RegularGrid(gridDataNegDy);
			const values = new Float32Array(Array.from({ length: 30 }, (_, index) => index));
			// Above the grid (lat > 56)
			expect(grid.getLinearInterpolatedValue(values, 57, 15)).toBeNaN();
			// Below the grid (lat < 50)
			expect(grid.getLinearInterpolatedValue(values, 49, 15)).toBeNaN();
			// Left of the grid (lon < 10)
			expect(grid.getLinearInterpolatedValue(values, 54, 9)).toBeNaN();
			// Right of the grid (lon > 20)
			expect(grid.getLinearInterpolatedValue(values, 54, 21)).toBeNaN();
		});

		test('getCoveringRanges with negative dy returns correct ranges', () => {
			const grid = new RegularGrid(gridDataNegDy);
			const ranges = grid.getCoveringRanges(52, 12, 55, 12.5);
			// south=52, north=55 → yFromSouth = (52-56)/(-2) = 2, yFromNorth = (55-56)/(-2) = 0.5
			// minY = max(floor(0.5) - 1, 0) = 0, maxY = min(ceil(2) + 1, 3) = 3
			expect(ranges[0].start).toBe(0);
			expect(ranges[0].end).toBe(gridDataNegDy.ny);
			// west=12, east=12.5 → same x calculation as positive dy
			expect(ranges[1].start).toBe(1);
			expect(ranges[1].end).toBe(4);
		});

		test('negative dy grid produces same interpolated values as positive dy for matching coordinates', () => {
			const gridPos = new RegularGrid(gridData);
			const gridNeg = new RegularGrid(gridDataNegDy);
			// Positive dy: row 0=lat50, row 1=lat52, row 2=lat54
			const valuesPos = new Float32Array(Array.from({ length: 30 }, (_, index) => index));
			// Negative dy: row 0=lat56, row 1=lat54, row 2=lat52
			// Geographic lat=54 is pos row 2, neg row 1
			// Geographic lat=52 is pos row 1, neg row 2
			// So neg row 1 should have pos row 2 values, neg row 2 should have pos row 1 values
			const valuesNeg = new Float32Array([
				...Array.from({ length: 10 }, (_, i) => 100 + i), // row 0 (lat=56) — no pos equivalent
				...Array.from({ length: 10 }, (_, i) => 20 + i), // row 1 (lat=54) = pos row 2
				...Array.from({ length: 10 }, (_, i) => 10 + i) // row 2 (lat=52) = pos row 1
			]);
			// Test at lat=52.5, lon=11.5 (interpolates between neg rows 1&2 / pos rows 1&2)
			const lat = 52.5;
			const lon = 11.5;
			const resultPos = gridPos.getLinearInterpolatedValue(valuesPos, lat, lon);
			const resultNeg = gridNeg.getLinearInterpolatedValue(valuesNeg, lat, lon);
			expect(resultPos).toBeCloseTo(resultNeg);
		});
	});

	test('getCoveringRanges returns correct ranges', () => {
		const grid = new RegularGrid(gridData);
		// TODO: The behavior of getCoveringRanges can surely be improved
		const ranges = grid.getCoveringRanges(52, 12, 55, 12.5);
		expect(ranges[0].start).toBe(0);
		expect(ranges[0].end).toBe(gridData.ny);
		expect(ranges[1].start).toBe(1);
		expect(ranges[1].end).toBe(4);
	});
});

describe('ProjectionGrid', () => {
	test('construction, bounds and center', () => {
		const grid = new ProjectionGrid(projectedGridData);
		const bounds = grid.getBounds();
		expect(bounds).toHaveLength(4);
		expect(bounds[0]).toBeCloseTo(10, 3);
		expect(bounds[1]).toBeCloseTo(49.992, 3); // latMin is a bit smaller than the specified latMin, because it is matched the next available value on the projection grid ???
		expect(bounds[2]).toBeCloseTo(11.426, 3); // approximate longitude max
		expect(bounds[3]).toBeCloseTo(50.899, 3); // approximate latitude max

		const center = grid.getCenter();
		expect(center.lng).toBeCloseTo(10.71, 2);
		expect(center.lat).toBeCloseTo(50.45, 2);
	});

	test('construction, bounds and center for partial grid', () => {
		const ranges: DimensionRange[] = [
			{ start: 0, end: 5 },
			{ start: 0, end: 5 }
		];
		const grid = new ProjectionGrid(projectedGridData, ranges);
		const bounds = grid.getBounds();
		// bounds should be smaller than the full grid
		expect(bounds).toHaveLength(4);
		expect(bounds[0]).toBeCloseTo(10, 3);
		expect(bounds[1]).toBeCloseTo(49.998, 3); // FIXME: Why is this not the same as above?
		expect(bounds[2]).toBeCloseTo(10.706, 3); // approximate longitude max
		expect(bounds[3]).toBeCloseTo(50.45, 3); // approximate latitude max

		const center = grid.getCenter();
		expect(center.lng).toBeCloseTo(10.35, 2);
		expect(center.lat).toBeCloseTo(50.22, 2);
	});

	test('linear interpolation', () => {
		const grid = new ProjectionGrid(projectedGridData);
		const values = new Float32Array(Array.from({ length: 100 }, (_, index) => index));

		// Test a point that should be within the grid
		const result = grid.getLinearInterpolatedValue(values, 50.001, 10.001);
		expect(result).toBeCloseTo(0.118, 3);
	});

	test('linear interpolation for partial grid', () => {
		const ranges: DimensionRange[] = [
			{ start: 0, end: 5 },
			{ start: 0, end: 5 }
		];
		const grid = new ProjectionGrid(projectedGridData, ranges);
		const values = new Float32Array([
			...Array.from({ length: 5 }, (_, index) => index),
			...Array.from({ length: 5 }, (_, index) => index + 10),
			...Array.from({ length: 5 }, (_, index) => index + 20),
			...Array.from({ length: 5 }, (_, index) => index + 30),
			...Array.from({ length: 5 }, (_, index) => index + 40)
		]);

		// Test a point that should be within the grid
		const result = grid.getLinearInterpolatedValue(values, 50.001, 10.001);
		expect(result).toBeCloseTo(0.118, 3);
	});

	test('returns NaN for out-of-bounds in projected grid', () => {
		const grid = new ProjectionGrid(projectedGridData);
		const values = new Float32Array(Array.from({ length: 100 }, (_, index) => index));

		// Test points outside the grid
		expect(grid.getLinearInterpolatedValue(values, 48, 10)).toBeNaN();
	});

	test('getCoveringRanges returns valid ranges', () => {
		const grid = new ProjectionGrid(projectedGridData);
		const ranges = grid.getCoveringRanges(49.9, 9.9, 50.1, 10.1);

		expect(ranges).toHaveLength(2);
		expect(ranges[0].start).toBeGreaterThanOrEqual(0);
		expect(ranges[0].end).toBeLessThanOrEqual(projectedGridData.ny);
		expect(ranges[1].start).toBeGreaterThanOrEqual(0);
		expect(ranges[1].end).toBeLessThanOrEqual(projectedGridData.nx);
		expect(ranges[0].start).toBeLessThanOrEqual(ranges[0].end);
		expect(ranges[1].start).toBeLessThanOrEqual(ranges[1].end);
	});
});
