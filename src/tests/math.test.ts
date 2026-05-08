import { fastAtan2, tile2lat, tile2lon } from '../utils/math';
import { describe, expect, test } from 'vitest';

describe('tile2lon', () => {
	test('returns -180 for x=0 at any zoom level', () => {
		expect(tile2lon(0, 0)).toBe(-180);
		expect(tile2lon(0, 1)).toBe(-180);
		expect(tile2lon(0, 10)).toBe(-180);
	});

	test('returns 0 for center tile at zoom > 0', () => {
		expect(tile2lon(1, 1)).toBe(0);
		expect(tile2lon(2, 2)).toBe(0);
		expect(tile2lon(512, 10)).toBe(0);
	});

	test('returns 180 (or -180 normalized) for max x at any zoom', () => {
		// At zoom z, max tile x = 2^z, which wraps to -180
		expect(tile2lon(1, 0)).toBe(-180);
		expect(tile2lon(2, 1)).toBe(-180);
		expect(tile2lon(4, 2)).toBe(-180);
	});

	test('returns correct longitude for known tile coordinates', () => {
		// At zoom 2: tiles 0,1,2,3 -> -180, -90, 0, 90
		expect(tile2lon(0, 2)).toBe(-180);
		expect(tile2lon(1, 2)).toBe(-90);
		expect(tile2lon(2, 2)).toBe(0);
		expect(tile2lon(3, 2)).toBe(90);
	});
});

describe('tile2lat', () => {
	test('returns ~85.05 for y=0 (north pole limit)', () => {
		// Web Mercator latitude limit is approximately ±85.0511287798
		expect(tile2lat(0, 0)).toBeCloseTo(85.0511287798, 5);
		expect(tile2lat(0, 1)).toBeCloseTo(85.0511287798, 5);
		expect(tile2lat(0, 10)).toBeCloseTo(85.0511287798, 5);
	});

	test('returns ~-85.05 for max y (south pole limit)', () => {
		expect(tile2lat(1, 0)).toBeCloseTo(-85.0511287798, 5);
		expect(tile2lat(2, 1)).toBeCloseTo(-85.0511287798, 5);
		expect(tile2lat(1024, 10)).toBeCloseTo(-85.0511287798, 5);
	});

	test('returns 0 for center tile at zoom > 0', () => {
		expect(tile2lat(1, 1)).toBeCloseTo(0, 10);
		expect(tile2lat(2, 2)).toBeCloseTo(0, 10);
		expect(tile2lat(512, 10)).toBeCloseTo(0, 10);
	});

	test('returns correct latitude for known tile coordinates', () => {
		// At zoom 2: y=0,1,2,3,4 maps to specific latitudes
		// y=0 -> ~85.05, y=2 -> 0, y=4 -> ~-85.05
		expect(tile2lat(0, 2)).toBeCloseTo(85.0511287798, 5);
		expect(tile2lat(2, 2)).toBeCloseTo(0, 5);
		expect(tile2lat(4, 2)).toBeCloseTo(-85.0511287798, 5);
	});
});

test('fastAtan2 approximates Math.atan2 within 0.00001 radians', () => {
	const steps = 1000;
	let maxError = 0;
	for (let i = 0; i <= steps; ++i) {
		const theta = -Math.PI + (2 * Math.PI * i) / steps;
		// Use a radius to avoid (0,0)
		const r = 1.0;
		const x = r * Math.cos(theta);
		const y = r * Math.sin(theta);

		const approx = fastAtan2(y, x);
		const exact = Math.atan2(y, x);
		const error = Math.abs(approx - exact);

		if (error > maxError) maxError = error;

		expect(error).toBeLessThan(0.00001);
	}
	// special values
	expect(fastAtan2(0, 0)).toBe(0);
	expect(fastAtan2(0, 1)).toBe(0);
	expect(fastAtan2(1, 0)).toBe(Math.PI / 2);
	expect(fastAtan2(0, -1)).toBe(Math.PI);
	expect(fastAtan2(-1, 0)).toBe(-Math.PI / 2);
});
