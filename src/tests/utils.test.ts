import { fastAtan2 } from '../utils/math';
import { expect, test } from 'vitest';

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
