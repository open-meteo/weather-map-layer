import { domainOptions } from '../domains';
import { ProjectionGrid } from '../grids/projected';
import { LambertConformalConicProjection, RotatedLatLonProjection } from '../grids/projections';
import { RegularGrid } from '../grids/regular';
import { describe, expect, test } from 'vitest';

import type {
	AnyProjectionGridData,
	DimensionRange,
	InterpolationMethod,
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

	test('constructs from inclusive lat/lon bounds', () => {
		// last node lands on the upper bound: dx = (19-10)/(10-1) = 1, dy = (54-50)/(3-1) = 2,
		// giving identical geometry to `gridData`
		const grid = new RegularGrid({
			type: 'regular',
			nx: 10,
			ny: 3,
			longitude: [10, 19],
			latitude: [50, 54]
		});
		expect(grid.getBounds()).toEqual([10, 50, 20, 56]);

		const values = new Float32Array(Array.from({ length: 30 }, (_, index) => index));
		// node (x=1, y=1) is at lon 11, lat 52 => index 11
		expect(grid.getLinearInterpolatedValue(values, 52, 11)).toBe(11);
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

describe('interpolation methods', () => {
	const methodGridData: RegularGridData = {
		type: 'regular',
		nx: 8,
		ny: 8,
		lonMin: 10,
		latMin: 50,
		dx: 1,
		dy: 1
	};

	test('unknown interpolation method throws', () => {
		const grid = new RegularGrid(methodGridData);
		const values = new Float32Array(64).fill(7);
		expect(() =>
			grid.getInterpolatedValue(values, 53.5, 13.5, undefined as unknown as InterpolationMethod)
		).toThrow(/Unknown interpolation method/);
	});

	test('all methods preserve a uniform field', () => {
		const grid = new RegularGrid(methodGridData);
		const values = new Float32Array(64).fill(7);
		for (const method of ['nearest', 'linear', 'cubic'] as const) {
			expect(grid.getInterpolatedValue(values, 53.5, 13.5, method)).toBeCloseTo(7);
		}
	});

	test("'nearest' returns the closest grid node, centred (round, not floor)", () => {
		const grid = new RegularGrid(methodGridData);
		const values = new Float32Array(Array.from({ length: 64 }, (_, i) => i));
		// lat 53.4 -> row 3, lon 12.6 -> rounds to col 3  =>  index 3*8 + 3 = 27
		// (flooring would give col 2 => 26, i.e. the old half-cell offset)
		expect(grid.getInterpolatedValue(values, 53.4, 12.6, 'nearest')).toBe(27);
	});

	// A gentle ramp quantised to 0.05 (temperature scalefactor 20). When a colour
	// breakpoint coincides with the plateau value, float noise in the sampler
	// used to dither the bucket and speckle the band edge.
	const quantizedRamp = () => {
		const nx = 80;
		const ny = 6;
		const grid = new RegularGrid({
			type: 'regular',
			nx,
			ny,
			lonMin: 0,
			latMin: 0,
			dx: 0.02,
			dy: 0.02
		});
		const values = new Float32Array(nx * ny);
		for (let j = 0; j < ny; j++)
			for (let i = 0; i < nx; i++) values[j * nx + i] = Math.round((14 + 0.002 * i) / 0.05) * 0.05;
		return { grid, values, nx };
	};

	test("'cubic' does not overshoot the local data range", () => {
		const { grid, values, nx } = quantizedRamp();
		for (let s = 0; s < 400; s++) {
			const lon = (s / 400) * (nx - 1) * 0.02;
			const v = grid.getInterpolatedValue(values, 0.05, lon, 'cubic');
			// data is in [14.0, 14.15]; Catmull-Rom overshoot must be clamped away
			expect(v).toBeGreaterThanOrEqual(14.0);
			expect(v).toBeLessThanOrEqual(14.15);
		}
	});

	test("'monotone' is shape-preserving: no overshoot and stays monotonic", () => {
		const { grid, values, nx } = quantizedRamp();
		let prev = -Infinity;
		for (let s = 0; s < 400; s++) {
			const lon = (s / 400) * (nx - 1) * 0.02;
			const v = grid.getInterpolatedValue(values, 0.05, lon, 'monotone');
			// PCHIP cannot overshoot the surrounding samples (no clamp needed)
			expect(v).toBeGreaterThanOrEqual(14.0);
			expect(v).toBeLessThanOrEqual(14.15);
			// the field never decreases in lon, so neither may the interpolant
			expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
			prev = v;
		}
	});

	test('one-grid-point-short global grid wraps (no NaN column at the antimeridian)', () => {
		// dwd_icon_eps shape: 0.25° grid stored one point short (nx=1439, span 359.75°).
		// The old hardcoded 359.875 threshold left this un-wrapped, producing a
		// missing column at the antimeridian.
		const nx = 1439;
		const ny = 721;
		const grid = new RegularGrid({
			type: 'regular',
			nx,
			ny,
			lonMin: -180,
			latMin: -90,
			dx: 0.25,
			dy: 0.25
		});
		const values = new Float32Array(nx * ny).fill(7);
		// Longitudes inside the wrapped final cell (179.5°..180°) must resolve, not NaN.
		for (const lon of [179.5, 179.6, 179.75, 179.9, 179.99]) {
			expect(isFinite(grid.getInterpolatedValue(values, 0, lon, 'linear'))).toBe(true);
		}
	});

	test('complete global grid keeps a full-width final cell at the antimeridian', () => {
		// ncep_gefs025/ncep_gfs025 shape: complete 0.25° grid (nx=1440, span 360°).
		// Its final cell must not be widened to 2*dx — doing so shifts the last
		// column and smears the data near the seam. A linear ramp in longitude
		// must stay linear right up to the seam.
		const nx = 1440;
		const ny = 4;
		const grid = new RegularGrid({
			type: 'regular',
			nx,
			ny,
			lonMin: -180,
			latMin: -1,
			dx: 0.25,
			dy: 0.25
		});
		// value == longitude index, so the seam wraps 1439 -> 0.
		const values = new Float32Array(nx * ny);
		for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) values[j * nx + i] = i;
		// At the last node (179.75° == column 1439) we should read ~1439 exactly,
		// not a value pulled halfway toward column 0 by a doubled cell.
		expect(grid.getInterpolatedValue(values, -0.5, 179.75, 'linear')).toBeCloseTo(1439, 5);
		// Halfway across the final cell wraps toward column 0: mean of 1439 and 0.
		expect(grid.getInterpolatedValue(values, -0.5, 179.875, 'linear')).toBeCloseTo(1439 / 2, 5);
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
