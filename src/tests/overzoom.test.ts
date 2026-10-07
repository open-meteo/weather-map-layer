import { overzoomTile } from '../node/overzoom';
import { describe, expect, it } from 'vitest';

import type { RgbaTile } from '../types';

/** A 4×4 tile whose red channel is the column and green channel the row, opaque. */
const gradient = (): RgbaTile => {
	const rgba = new Uint8ClampedArray(4 * 4 * 4);
	for (let y = 0; y < 4; y++) {
		for (let x = 0; x < 4; x++) {
			rgba.set([x * 60, y * 60, 0, 255], (y * 4 + x) * 4);
		}
	}
	return { width: 4, height: 4, rgba };
};

describe('overzoomTile', () => {
	it('magnifies the requested quadrant to the tile size', () => {
		const tile = overzoomTile(gradient(), 1, 1, 0);
		expect(tile.width).toBe(4);
		expect(tile.rgba.length).toBe(4 * 4 * 4);
		// Top-right quadrant: columns 2..3 of the parent, so red is high, green
		// low. The first column blends with the neighbouring quadrant, as a map
		// client's magnification does across tile edges.
		const red = (x: number, y: number) => tile.rgba[(y * 4 + x) * 4];
		const green = (x: number, y: number) => tile.rgba[(y * 4 + x) * 4 + 1];
		expect(red(0, 0)).toBe(105);
		expect(red(3, 0)).toBe(180);
		expect(green(0, 3)).toBe(75);
		expect(tile.rgba[3]).toBe(255);
	});

	it('interpolates between parent pixels', () => {
		const tile = overzoomTile(gradient(), 1, 0, 0);
		const red = (x: number) => tile.rgba[x * 4];
		// Two child pixels per parent pixel: values step up smoothly, not in pairs
		expect(red(0)).toBe(0);
		expect(red(1)).toBe(15);
		expect(red(2)).toBe(45);
		expect(red(3)).toBe(75);
	});

	it('goes down several levels at once', () => {
		const tile = overzoomTile(gradient(), 2, 3, 3);
		// The bottom-right sixteenth: the parent's last pixel, blending with its neighbours
		expect(Array.from(tile.rgba.subarray(0, 4))).toEqual([158, 158, 0, 255]);
		expect(Array.from(tile.rgba.subarray(tile.rgba.length - 4))).toEqual([180, 180, 0, 255]);
	});
});
