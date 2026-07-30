import { COLOR_SCALES } from './color-scales';
import { pressureHpaToIsaHeight } from './isa-height';

import type {
	BreakpointColorScale,
	ColorScale,
	ColorScales,
	RenderableColorScale,
	ResolvedBreakpointColorScale
} from '../types';

function findLastIndexLE(arr: number[], value: number): number {
	let lo = 0,
		hi = arr.length - 1,
		res = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		if (arr[mid] <= value) {
			res = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return res;
}

const lerpColor = (
	a: [number, number, number, number],
	b: [number, number, number, number],
	t: number,
	out: [number, number, number, number] = [0, 0, 0, 0]
): [number, number, number, number] => {
	out[0] = a[0] + (b[0] - a[0]) * t;
	out[1] = a[1] + (b[1] - a[1]) * t;
	out[2] = a[2] + (b[2] - a[2]) * t;
	out[3] = a[3] + (b[3] - a[3]) * t;
	return out;
};

export const getColor = (
	colorScale: RenderableColorScale,
	px: number,
	blend: boolean = false,
	// Optional reusable buffer for the blended result. Hot paths (the raster
	// worker's per-pixel loop) pass one to avoid allocating an array per pixel.
	// The non-blend path returns the scale's own colour, so `out` is ignored there.
	out?: [number, number, number, number]
): [number, number, number, number] => {
	switch (colorScale.type) {
		case 'rgba': {
			const colors = colorScale.colors;
			const deltaPerIndex = (colorScale.max - colorScale.min) / colors.length;
			const pos = (px - colorScale.min) / deltaPerIndex;
			const index = Math.min(colors.length - 1, Math.max(0, Math.floor(pos)));
			if (!blend) return colors[index];
			const next = Math.min(colors.length - 1, index + 1);
			const t = Math.min(1, Math.max(0, pos - index));
			return lerpColor(colors[index], colors[next], t, out);
		}
		case 'breakpoint': {
			const breakpoints = colorScale.breakpoints;
			const colors = colorScale.colors;
			const index = Math.max(0, findLastIndexLE(breakpoints, px));
			if (!blend) return colors[index];
			const next = Math.min(colors.length - 1, index + 1);
			const lo = breakpoints[index];
			const hi = breakpoints[next];
			const t = hi > lo ? Math.min(1, Math.max(0, (px - lo) / (hi - lo))) : 0;
			return lerpColor(colors[index], colors[next], t, out);
		}
		default: {
			// This ensures exhaustiveness checking
			const _exhaustive: never = colorScale;
			throw new Error(`Unknown color scale: ${_exhaustive}`);
		}
	}
};

// A colour lookup specialised to one scale, with the per-tile invariants
// (rgba index scale, breakpoint/colour arrays) resolved once. The raster worker
// builds this once per tile and calls it per pixel, avoiding the `switch` and the
// `(max-min)/length` division that getColor repeats on every pixel. `out` is the
// reusable blend buffer (ignored on the non-blend path, which returns the scale's
// own colour).
export type ColorSampler = (
	px: number,
	out: [number, number, number, number]
) => [number, number, number, number];

export const makeColorSampler = (
	colorScale: RenderableColorScale,
	blend: boolean = false
): ColorSampler => {
	switch (colorScale.type) {
		case 'rgba': {
			const colors = colorScale.colors;
			const last = colors.length - 1;
			const min = colorScale.min;
			// index = (px - min) / deltaPerIndex == (px - min) * (length / (max - min))
			const scale = colors.length / (colorScale.max - colorScale.min);
			if (!blend) {
				return (px) => colors[Math.min(last, Math.max(0, Math.floor((px - min) * scale)))];
			}
			return (px, out) => {
				const pos = (px - min) * scale;
				const index = Math.min(last, Math.max(0, Math.floor(pos)));
				const next = Math.min(last, index + 1);
				const t = Math.min(1, Math.max(0, pos - index));
				return lerpColor(colors[index], colors[next], t, out);
			};
		}
		case 'breakpoint': {
			const breakpoints = colorScale.breakpoints;
			const colors = colorScale.colors;
			const last = colors.length - 1;
			if (!blend) {
				return (px) => colors[Math.max(0, findLastIndexLE(breakpoints, px))];
			}
			return (px, out) => {
				const index = Math.max(0, findLastIndexLE(breakpoints, px));
				const next = Math.min(last, index + 1);
				const lo = breakpoints[index];
				const hi = breakpoints[next];
				const t = hi > lo ? Math.min(1, Math.max(0, (px - lo) / (hi - lo))) : 0;
				return lerpColor(colors[index], colors[next], t, out);
			};
		}
		default: {
			// This ensures exhaustiveness checking
			const _exhaustive: never = colorScale;
			throw new Error(`Unknown color scale: ${_exhaustive}`);
		}
	}
};

const transformScale = (
	scale: BreakpointColorScale,
	transform: (breakpoint: number) => number,
	maybeUnit?: string
): BreakpointColorScale => {
	const breakpoints = scale.breakpoints.map(transform);
	const unit = maybeUnit || scale.unit;
	return {
		...scale,
		breakpoints,
		unit
	};
};

const freezingLevelHeightScale = transformScale(
	COLOR_SCALES['temperature'] as BreakpointColorScale,
	(b) => (b + 15) * 80,
	'm'
);

export const COLOR_SCALES_WITH_ALIASES: ColorScales = {
	...COLOR_SCALES,
	boundary_layer_height: transformScale(
		COLOR_SCALES['convective_cloud_top'] as BreakpointColorScale,
		(b) => b / 2
	),
	cloud_base: COLOR_SCALES['convective_cloud_top'],
	cloud_top: COLOR_SCALES['convective_cloud_top'],
	convective_cloud_base: COLOR_SCALES['convective_cloud_top'],
	dew_point: COLOR_SCALES['temperature'],
	diffuse_radiation: COLOR_SCALES['shortwave'],
	direct_radiation: COLOR_SCALES['shortwave'],
	freezing_level_height: freezingLevelHeightScale,
	latent_heat_flux: {
		...COLOR_SCALES['temperature'],
		unit: 'W/m²'
	},
	sea_surface_temperature: COLOR_SCALES['temperature'],
	sensible_heat_flux: {
		...COLOR_SCALES['temperature'],
		unit: 'W/m²'
	},
	rain: COLOR_SCALES['precipitation'],
	showers: COLOR_SCALES['precipitation'],
	snow_depth_water_equivalent: transformScale(
		COLOR_SCALES['precipitation'] as BreakpointColorScale,
		(b) => b * 200
	),
	snowfall_height: freezingLevelHeightScale,
	snowfall_water_equivalent: COLOR_SCALES['precipitation'],
	visibility: {
		...COLOR_SCALES['geopotential_height'],
		unit: 'W/m²'
	},
	wave: COLOR_SCALES['swell'],
	wind_wave_height: COLOR_SCALES['swell'],
	swell_wave_height: COLOR_SCALES['swell'],
	secondary_swell_wave_height: COLOR_SCALES['swell'],
	tertiary_swell_wave_height: COLOR_SCALES['swell'],
	wave_peak_period: COLOR_SCALES['swell_period'],
	wave_period: COLOR_SCALES['swell_period'],
	swell_wave_period: COLOR_SCALES['swell_period'],
	secondary_swell_wave_period: COLOR_SCALES['swell_period'],
	tertiary_swell_wave_period: COLOR_SCALES['swell_period']
};

const getOptionalColorScale = (
	variable: string,
	colorScalesSource: ColorScales
): ColorScale | undefined => {
	const exactMatch = colorScalesSource[variable];
	if (exactMatch) return exactMatch;
	const parts = variable.split('_');
	const lastIndex = parts.length - 1;

	const scale = colorScalesSource[parts[0] + '_' + parts[1]] ?? colorScalesSource[parts[0]];

	// geopotential height variables -> derive typical height from ISA
	if (variable.includes('geopotential_height')) {
		// try to parse level from the variable string, e.g. geopotential_height_500hPa
		const m = variable.match(LEVEL_REGEX);
		if (!m) {
			return scale;
		}

		if (scale.type !== 'breakpoint') {
			return scale;
		}

		const levelNum = Number(m[1]);

		// geopotential_height color scale is defined on 500hPa -> scale it accordingly to other heights
		const h500 = pressureHpaToIsaHeight(500);
		const hLevel = pressureHpaToIsaHeight(levelNum);

		const breakpoints = scale.breakpoints.map((breakpoint) => {
			return (breakpoint * hLevel) / h500;
		});

		return {
			...scale,
			breakpoints
		};
	}

	if (['mean', 'max', 'min'].includes(parts[lastIndex])) {
		return getOptionalColorScale(parts.slice(0, -1).join('_'), colorScalesSource);
	} else if (parts[lastIndex] == 'anomaly') {
		return colorScalesSource['temperature_anomaly'];
	}
	return colorScalesSource[parts[0] + '_' + parts[1]] ?? colorScalesSource[parts[0]];
};

export const getColorScale = (
	variable: string,
	dark: boolean,
	colorScalesSource: ColorScales = COLOR_SCALES_WITH_ALIASES
): RenderableColorScale => {
	const anyColorScale =
		getOptionalColorScale(variable, colorScalesSource) ?? colorScalesSource['temperature'];
	if (!anyColorScale) {
		throw new Error(`Unknown color scale for variable: ${variable}`);
	}
	return resolveColorScale(anyColorScale, dark);
};

// Helper to check if colors have light/dark variants
const hasColorVariants = (
	colors: BreakpointColorScale['colors']
): colors is {
	light: [number, number, number, number][];
	dark: [number, number, number, number][];
} => {
	return !Array.isArray(colors) && 'light' in colors && 'dark' in colors;
};

export const resolveColorScale = (colorScale: ColorScale, dark: boolean): RenderableColorScale => {
	switch (colorScale.type) {
		case 'rgba':
			return colorScale;
		case 'breakpoint': {
			if (hasColorVariants(colorScale.colors)) {
				return {
					...colorScale,
					colors: dark ? colorScale.colors.dark : colorScale.colors.light
				} as ResolvedBreakpointColorScale;
			}
			return colorScale as ResolvedBreakpointColorScale;
		}
		default: {
			// This ensures exhaustiveness checking
			const _exhaustive: never = colorScale;
			throw new Error(`Unknown color scale: ${_exhaustive}`);
		}
	}
};

const LEVEL_REGEX = /_(\d+)(hPa)?$/i;
