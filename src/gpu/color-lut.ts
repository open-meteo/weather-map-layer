/**
 * Bakes a colour scale into a 1D RGBA8 lookup-table texture.
 *
 * The LUT is filled by the exact CPU colour sampler (`makeColorSampler`), so
 * the GPU path inherits the CPU colour semantics by construction. The shader
 * maps a data value to the normalised LUT coordinate with (min, 1/(max-min));
 * values outside the range clamp, matching the CPU index clamping.
 *
 * - colorBlend = true: sampled LINEAR — the dense piecewise-linear bake makes
 *   this visually exact.
 * - colorBlend = false: sampled NEAREST — band edges are quantised to the LUT
 *   resolution (range / LUT_SIZE), a known approximation of the exploration
 *   phase (an exact in-shader breakpoint search is a possible follow-up).
 */
import { makeColorSampler } from '../utils/styling';

import type { RenderableColorScale } from '../types';

export const LUT_SIZE = 2048;

export interface ColorLut {
	data: Uint8Array;
	/** Data value mapped to the first LUT texel. */
	min: number;
	/** Data value mapped to the last LUT texel. */
	max: number;
}

const scaleDomain = (scale: RenderableColorScale): [number, number] => {
	if (scale.type === 'rgba') {
		return [scale.min, scale.max];
	}
	const breakpoints = scale.breakpoints;
	return [breakpoints[0], breakpoints[breakpoints.length - 1]];
};

export const buildColorLut = (scale: RenderableColorScale, blend: boolean): ColorLut => {
	const domain = scaleDomain(scale);
	const min = domain[0];
	let max = domain[1];
	if (!(max > min)) {
		// Degenerate scale; avoid a division by zero in the shader mapping.
		max = min + 1;
	}

	const sampler = makeColorSampler(scale, blend);
	const out: [number, number, number, number] = [0, 0, 0, 0];
	const data = new Uint8Array(LUT_SIZE * 4);
	const step = (max - min) / (LUT_SIZE - 1);
	for (let i = 0; i < LUT_SIZE; i++) {
		const color = sampler(min + i * step, out);
		data[4 * i] = color[0];
		data[4 * i + 1] = color[1];
		data[4 * i + 2] = color[2];
		// Scale colours carry alpha in 0..1 (multiplied by 255 in the CPU worker).
		data[4 * i + 3] = Math.round(255 * color[3]);
	}
	return { data, min, max };
};

/** Cache key covering everything that changes the baked LUT. */
export const colorLutKey = (scale: RenderableColorScale, blend: boolean): string => {
	if (scale.type === 'rgba') {
		return `rgba|${blend}|${scale.min}|${scale.max}|${JSON.stringify(scale.colors)}`;
	}
	return `breakpoint|${blend}|${JSON.stringify(scale.breakpoints)}|${JSON.stringify(scale.colors)}`;
};
