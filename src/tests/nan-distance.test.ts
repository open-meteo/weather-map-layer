import { computeNanDistanceField } from '../utils/nan-distance';
import { describe, expect, it } from 'vitest';

describe('computeNanDistanceField', () => {
	it('returns undefined when there is no missing data', () => {
		expect(computeNanDistanceField(new Float32Array(9).fill(1), 3, 3, 1, 1)).toBeUndefined();
	});

	it('measures the degree distance to the nearest NaN along a row', () => {
		// [NaN, 1, 1, 1, 1] with dx=2 → distances 0,2,4,6,8
		const field = computeNanDistanceField(new Float32Array([NaN, 1, 1, 1, 1]), 5, 1, 2, 1)!;
		expect(Array.from(field)).toEqual([0, 2, 4, 6, 8]);
	});

	it('reports 0 at NaN cells and grows away from the NaN boundary', () => {
		// 5×5 grid, valid only in the centre cell, NaN everywhere else.
		const values = new Float32Array(25).fill(NaN);
		values[2 * 5 + 2] = 1;
		const field = computeNanDistanceField(values, 5, 5, 1, 1)!;
		expect(field[2 * 5 + 2]).toBeCloseTo(1, 5); // centre is one cell from NaN
		expect(field[0]).toBe(0); // a NaN cell
	});
});
