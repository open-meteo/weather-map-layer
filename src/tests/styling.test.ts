import { getColor } from '../utils/styling';
import { describe, expect, test } from 'vitest';

import type { RenderableColorScale } from '../types';

const scale: RenderableColorScale = {
	type: 'breakpoint',
	unit: '°C',
	breakpoints: [0, 10, 20],
	colors: [
		[0, 0, 0, 1],
		[100, 0, 0, 1],
		[200, 0, 0, 1]
	]
};

describe('getColor', () => {
	test('non-blend returns the scale colour for the band', () => {
		expect(getColor(scale, 15, false)).toEqual([100, 0, 0, 1]);
	});

	test('blend interpolates between adjacent band colours', () => {
		// px 15 is halfway between breakpoints 10 and 20
		expect(getColor(scale, 15, true)).toEqual([150, 0, 0, 1]);
	});

	test('blend fills and returns the provided out buffer (no per-call allocation)', () => {
		const out: [number, number, number, number] = [0, 0, 0, 0];
		const result = getColor(scale, 15, true, out);
		expect(result).toBe(out); // same reference => reused, not freshly allocated
		expect(out).toEqual([150, 0, 0, 1]);
	});

	test('the out buffer is reused (overwritten) across calls', () => {
		const out: [number, number, number, number] = [0, 0, 0, 0];
		expect(getColor(scale, 12.5, true, out)).toBe(out); // t=0.25 -> [125,0,0,1]
		expect(getColor(scale, 17.5, true, out)).toBe(out); // t=0.75 -> [175,0,0,1]
		expect(out).toEqual([175, 0, 0, 1]);
	});
});
