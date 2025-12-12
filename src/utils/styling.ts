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

export const getColor = (
	colorScale: RenderableColorScale,
	px: number
): [number, number, number, number] => {
	switch (colorScale.type) {
		case 'rgba': {
			const deltaPerIndex = (colorScale.max - colorScale.min) / colorScale.colors.length;
			const index = Math.min(
				colorScale.colors.length - 1,
				Math.max(0, Math.floor((px - colorScale.min) / deltaPerIndex))
			);
			return colorScale.colors[index];
		}
		case 'breakpoint': {
			const index = Math.max(0, findLastIndexLE(colorScale.breakpoints, px));
			return colorScale.colors[index];
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

export const COLOR_SCALES_WITH_ALIASES: ColorScales = {
	...COLOR_SCALES,
	albedo: COLOR_SCALES['cloud_cover'],
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
	freezing_level_height: transformScale(
		COLOR_SCALES['temperature'] as BreakpointColorScale,
		(b) => (b + 20) * 80,
		'm'
	),
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
