import { bilinearAngleNaNAware, bilinearNaNAware } from '../grids/interpolations';
import { describe, expect, test } from 'vitest';

describe('bilinearAngleNaNAware', () => {
	test('blends across the 0°/360° seam', () => {
		// Halfway between 350° and 10° is due north, not the 180° a scalar blend gives
		expect(bilinearAngleNaNAware(350, 10, 350, 10, 0.5, 0.5, 0.5)).toBeCloseTo(0);
	});

	test('matches the scalar blend away from the seam', () => {
		expect(bilinearAngleNaNAware(30, 50, 30, 50, 0.5, 0.5, 0.5)).toBeCloseTo(40);
	});

	test('ignores corners that carry no weight', () => {
		// xf = 1 and yFraction = 0.5 → only p1 and p3 contribute; their mean is 180°.
		// Unwrapping around p0 used to map them to 170°/-170° and return 0°, i.e. a
		// flipped arrow.
		expect(bilinearAngleNaNAware(0, 170, 0, 190, 1, 1, 0.5)).toBeCloseTo(180);
	});

	test('keeps the NaN/triangle handling of the scalar bilinear', () => {
		// Two missing corners → no valid triangle
		expect(bilinearAngleNaNAware(NaN, 10, NaN, 20, 0.5, 0.5, 0.5)).toBeNaN();
		// p0 missing and the sample outside the remaining triangle
		expect(bilinearAngleNaNAware(NaN, 10, 20, 30, 0.2, 0.2, 0.2)).toBeNaN();
		expect(bilinearNaNAware(NaN, 10, 20, 30, 0.2, 0.2, 0.2)).toBeNaN();
		// p0 missing and the sample inside it → the remaining three corners blend.
		// The circular mean pulls slightly off the scalar mean (a chord is shorter
		// than its arc), so this is close to, not equal to, the scalar result.
		expect(bilinearAngleNaNAware(NaN, 10, 20, 30, 0.8, 0.8, 0.8)).toBeCloseTo(
			bilinearNaNAware(NaN, 10, 20, 30, 0.8, 0.8, 0.8),
			1
		);
	});
});
