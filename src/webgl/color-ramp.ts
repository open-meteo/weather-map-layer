import { getColorScale, makeColorSampler } from '../utils/styling';

import type { RenderableColorScale } from '../types';

export interface LegacyWebGLColorStop {
	value: number;
	color: number[];
}

export type WebGLColorScale = RenderableColorScale | LegacyWebGLColorStop[];

export const isLegacyColorScale = (scale: WebGLColorScale): scale is LegacyWebGLColorStop[] =>
	Array.isArray(scale);

export const resolveWebGLColorScale = (
	variable: string,
	scale: WebGLColorScale | undefined,
	darkMode: boolean
): WebGLColorScale => scale ?? getColorScale(variable, darkMode);

export const colorScaleRange = (scale: WebGLColorScale): [number, number] => {
	if (isLegacyColorScale(scale)) {
		if (!scale.length) throw new Error('A WebGL color scale must contain at least one stop.');
		return [scale[0].value, scale[scale.length - 1].value];
	}
	return scale.type === 'rgba'
		? [scale.min, scale.max]
		: [scale.breakpoints[0], scale.breakpoints[scale.breakpoints.length - 1]];
};

const legacyColorAt = (
	scale: LegacyWebGLColorStop[],
	value: number,
	blend: boolean
): [number, number, number, number] => {
	let lower = scale[0];
	let upper = scale[scale.length - 1];
	for (let index = 0; index < scale.length - 1; index++) {
		if (value >= scale[index].value && value <= scale[index + 1].value) {
			lower = scale[index];
			upper = scale[index + 1];
			break;
		}
	}
	const span = upper.value - lower.value;
	const t = blend && span ? (value - lower.value) / span : 0;
	const color = [0, 0, 0, 255] as [number, number, number, number];
	for (let channel = 0; channel < 4; channel++) {
		color[channel] =
			(lower.color[channel] ?? (channel === 3 ? 255 : 0)) * (1 - t) +
			(upper.color[channel] ?? (channel === 3 ? 255 : 0)) * t;
	}
	return color;
};

export const createColorRampBytes = (
	scale: WebGLColorScale,
	blend: boolean,
	width: number = 256
): Uint8Array => {
	const bytes = new Uint8Array(width * 4);
	const [minimum, maximum] = colorScaleRange(scale);
	const sampler = isLegacyColorScale(scale) ? undefined : makeColorSampler(scale, blend);
	const temporary: [number, number, number, number] = [0, 0, 0, 0];

	for (let index = 0; index < width; index++) {
		const value = minimum + (index / (width - 1)) * (maximum - minimum);
		const color = isLegacyColorScale(scale)
			? legacyColorAt(scale, value, blend)
			: sampler!(value, temporary);
		const offset = index * 4;
		bytes[offset] = Math.round(color[0]);
		bytes[offset + 1] = Math.round(color[1]);
		bytes[offset + 2] = Math.round(color[2]);
		bytes[offset + 3] = Math.round(color[3] <= 1 ? color[3] * 255 : color[3]);
	}
	return bytes;
};
