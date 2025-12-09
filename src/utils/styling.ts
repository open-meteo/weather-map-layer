import { COLOR_SCALES } from './color-scales';
import { pressureHpaToIsaHeight } from './isa-height';

import type {
	ColorScale,
	ColorScales,
	OpacityDefinition,
	OpacityFn,
	RGB,
	RGBA,
	RGBAColorScale,
	ResolvableColorScale
} from '../types';

export const getColor = (
	colorScale: RGBAColorScale,
	px: number
): [number, number, number, number] => {
	const deltaPerIndex = (colorScale.max - colorScale.min) / colorScale.colors.length;
	const index = Math.min(
		colorScale.colors.length - 1,
		Math.max(0, Math.floor((px - colorScale.min) / deltaPerIndex))
	);

	return colorScale.colors[index];
};

const centeredPowerOpacity = (scale: number, exponent = 1.5, opacity = 75): OpacityFn => {
	return (px: number) => {
		const frac = Math.min(Math.pow(Math.abs(px) / scale, exponent), 1);
		return Math.max(0, Math.min(100, frac * opacity));
	};
};

const constantOpacity = (opacity: number = 75): OpacityFn => {
	return (_px: number) => opacity;
};

const COLOR_SCALES_WITH_ALIASES: ColorScales = {
	...COLOR_SCALES,
	albedo: COLOR_SCALES['cloud_cover'],
	boundary_layer_height: { ...COLOR_SCALES['convective_cloud_top'], min: 0, max: 2000 },
	cloud_base: COLOR_SCALES['convective_cloud_top'],
	cloud_top: COLOR_SCALES['convective_cloud_top'],
	convective_cloud_base: COLOR_SCALES['convective_cloud_top'],
	dew_point: COLOR_SCALES['temperature'],
	diffuse_radiation: COLOR_SCALES['shortwave'],
	direct_radiation: COLOR_SCALES['shortwave'],
	freezing_level_height: { ...COLOR_SCALES['temperature'], unit: 'm', min: 0, max: 4000 },
	latent_heat_flux: {
		...COLOR_SCALES['temperature'],
		unit: 'W/m²',
		min: -50,
		max: 20
	},
	sea_surface_temperature: {
		...COLOR_SCALES['temperature'],
		min: -2,
		max: 35
	},
	sensible_heat_flux: {
		...COLOR_SCALES['temperature'],
		unit: 'W/m²',
		min: -50,
		max: 50
	},
	rain: COLOR_SCALES['precipitation'],
	showers: COLOR_SCALES['precipitation'],
	snow_depth_water_equivalent: { ...COLOR_SCALES['precipitation'], unit: 'mm', min: 0, max: 3200 },
	snowfall_water_equivalent: COLOR_SCALES['precipitation'],
	visibility: {
		...COLOR_SCALES['geopotential_height'],
		min: 0,
		max: 20000
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

		const levelNum = Number(m[1]);
		// Compute ISA height (meters) for the pressure level
		const computedMax = pressureHpaToIsaHeight(Math.floor(0.9 * levelNum));
		const computedMin = pressureHpaToIsaHeight(Math.ceil(1.1 * levelNum));

		return {
			...scale,
			min: computedMin,
			max: computedMax
		};
	}

	if (['mean', 'max', 'min'].includes(parts[lastIndex])) {
		return getOptionalColorScale(parts.slice(0, -1).join('_'), colorScalesSource);
	} else if (parts[lastIndex] == 'anomaly') {
		const match = getOptionalColorScale(parts.slice(0, -1).join('_'), colorScalesSource);
		if (match && match.type === 'alpha_resolvable') {
			const delta = (match.max - match.min) / 5;
			return { ...match, max: delta, min: -delta, opacity: centeredPowerOpacity(delta * 0.5) };
		}
	}
	return colorScalesSource[parts[0] + '_' + parts[1]] ?? colorScalesSource[parts[0]];
};

export const getColorScale = (
	variable: string,
	dark: boolean,
	colorScalesSource: ColorScales = COLOR_SCALES_WITH_ALIASES
): RGBAColorScale => {
	const anyColorScale =
		getOptionalColorScale(variable, colorScalesSource) ?? colorScalesSource['temperature'];
	if (!anyColorScale) {
		throw new Error(`Unknown color scale for variable: ${variable}`);
	}
	return resolveColorScale(anyColorScale, dark);
};

export const resolveColorScale = (colorScale: ColorScale, dark: boolean): RGBAColorScale => {
	switch (colorScale.type) {
		case 'alpha_resolvable':
			return resolveResolvableColorScale(colorScale, dark);
		case 'rgba':
			return colorScale;
		default: {
			// This ensures exhaustiveness checking
			const _exhaustive: never = colorScale;
			throw new Error(`Unknown color scale: ${_exhaustive}`);
		}
	}
};

const resolveResolvableColorScale = (
	colorScale: ResolvableColorScale,
	dark: boolean
): RGBAColorScale => {
	const colors: [number, number, number][] = Array.isArray(colorScale.colors)
		? colorScale.colors
		: dark
			? colorScale.colors.dark
			: colorScale.colors.light;

	const opacityFn = normalizeOpacity(colorScale.opacity, dark);
	const rgbaColors = applyOpacityToColors(colors, colorScale, opacityFn);

	return {
		type: 'rgba',
		min: colorScale.min,
		max: colorScale.max,
		unit: colorScale.unit,
		colors: rgbaColors
	};
};

const applyOpacityToColors = (
	colors: RGB[],
	colorScale: ResolvableColorScale,
	opacityFn: OpacityFn
): RGBA[] => {
	if (colors.length === 0) return [];

	const steps = Math.max(1, colors.length - 1);
	const delta = (colorScale.max - colorScale.min) / steps;

	return colors.map((rgb, i) => {
		const px = colorScale.min + delta * i;
		const alpha = opacityFn(px);
		return [...rgb, alpha] as RGBA;
	});
};

type NormalizedOpacityFn = (px: number) => number;

const normalizeOpacity = (
	def: OpacityDefinition | undefined,
	dark: boolean
): NormalizedOpacityFn => {
	if (def == null || def === undefined) {
		return constantOpacity(dark ? 0.55 : 0.75);
	}

	if (typeof def === 'number') {
		return constantOpacity(def);
	}
	// def is a function matching OpacityFn (px, dark?)
	const fn = def as OpacityFn;
	return (px: number) => {
		const result = fn(px, dark);
		const n = Number(result);
		if (!Number.isFinite(n)) return clampOpacity(dark ? 0.55 : 0.75);
		return clampOpacity(n);
	};
};

const clampOpacity = (v: number) => Math.max(0, Math.min(1, v));

const LEVEL_REGEX = /_(\d+)(hPa)?$/i;
