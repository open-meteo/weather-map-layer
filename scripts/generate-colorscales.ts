import '../src/utils/styling';
import { color } from 'd3-color';
import { interpolateHsl, interpolateRgb } from 'd3-interpolate';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import type { RGB } from '../src/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function interpolateColorScale(
	colors: string[],
	steps: number,
	interpolationMethod: 'hsl' | 'rgb' = 'hsl'
): [number, number, number][] {
	const segments = colors.length - 1;
	const stepsPerSegment = Math.floor(steps / segments);
	const remainder = steps % segments;

	const rgbArray: [number, number, number][] = [];

	for (let i = 0; i < segments; i++) {
		const startColor = colors[i];
		const endColor = colors[i + 1];
		const interpolate =
			interpolationMethod === 'hsl'
				? interpolateHsl(startColor, endColor)
				: interpolateRgb(startColor, endColor);

		const numSteps = stepsPerSegment + (i < remainder ? 1 : 0);

		for (let j = 0; j < numSteps; j++) {
			const t = j / (numSteps - 1);
			const c = color(interpolate(t))!.rgb();
			rgbArray.push([Math.round(c.r), Math.round(c.g), Math.round(c.b)]);
		}
	}

	return rgbArray;
}

const linearThenConstantWithThreshold = (
	threshold: number = 1.5,
	opacity: number = 0.75
): string => {
	return `(px: number) => Math.min(px / ${threshold}, 1) * ${opacity}`;
};

const powerScaleOpacity = (exponent = 1.5, denom = 100, opacity = 0.75): string => {
	return `(px: number) => Math.min(Math.max((Math.pow(Math.max(px, 0), ${exponent}) / ${denom}) * ${opacity}, 0), 1)`;
};

const powerThenConstant = (
	threshold: number = 1.5,
	exponent = 1.5,
	denom = 1000,
	opacity = 0.75
): string => {
	return `(px: number) => {
		if (px < ${threshold}) {
			return Math.min(Math.pow(px, ${exponent}) / ${denom}, 1) * ${opacity};
		}
		return ${opacity};
	}`;
};

const colorScaleDefinitions: Record<string, ColorScaleDefinition> = {
	cape: {
		unit: 'J/kg',
		min: 0,
		max: 4000,
		steps: 100,
		colors: ['green', 'orange', 'red'],
		opacity: powerScaleOpacity(1.5, 1000, 0.75)
	},
	cloud_cover: {
		unit: '%',
		min: 0,
		max: 100,
		steps: 20,
		colors: {
			light: ['#ffffff', '#f1f5f9', '#d1d5db', '#9ca3af', '#4b5563'],
			dark: ['#0b1220', '#131827', '#1b2431', '#27303a', '#39414a']
		},
		opacity: powerScaleOpacity()
	},
	convective_inhibition: {
		unit: 'J/kg',
		min: 0,
		max: 500,
		steps: 20,
		colors: ['white', 'purple', 'turquoise', 'green', 'orange', 'red', 'beige']
	},
	convective_cloud_top: {
		unit: 'm',
		min: 0,
		max: 6200,
		steps: 100,
		colors: ['#c0392b', '#d35400', '#f1c40f', '#16a085', '#2980b9'],
		opacity: powerScaleOpacity(1.5, 5000, 0.75)
	},
	geopotential_height: {
		unit: 'm',
		min: 4600,
		max: 6000,
		steps: 40,
		colors: ['#2E8B7A', '#5A3E8A', '#003366', '#006400', '#B5A000', '#550000']
	},
	precipitation: {
		unit: 'mm',
		min: 0,
		max: 20,
		steps: 40,
		colors: [
			{ colors: ['blue', 'green'], steps: 10 },
			{ colors: ['green', 'orange'], steps: 10 },
			{ colors: ['orange', 'red'], steps: 20 }
		],
		opacity: powerScaleOpacity(5, 0.01, 0.75)
	},
	pressure: {
		unit: 'hPa',
		min: 950,
		max: 1050,
		steps: 50,
		colors: ['#4444ff', '#fff', '#ff4444']
	},
	relative: {
		unit: '%',
		min: 0,
		max: 100,
		steps: 100,
		colors: ['#009392', '#39b185', '#9ccb86', '#e9e29c', '#eeb479', '#e88471', '#cf597e'].reverse()
	},
	shortwave: {
		unit: 'W/m^2',
		min: 0,
		max: 1000,
		steps: 100,
		colors: ['#009392', '#39b185', '#9ccb86', '#e9e29c', '#eeb479', '#e88471', '#cf597e']
	},
	snow_depth: {
		unit: 'm',
		min: 0,
		max: 5,
		steps: 40,
		colors: [
			{ colors: ['green', 'yellow'], steps: 14 },
			{ colors: ['yellow', 'red'], steps: 14 },
			{ colors: ['red', 'purple'], steps: 12 }
		],
		opacity: linearThenConstantWithThreshold(0.01)
	},
	soil_moisture: {
		unit: 'vol. %',
		min: 0,
		max: 0.5,
		steps: 20,
		colors: [
			{ colors: ['#e8c88a', '#c68b67'], steps: 6 },
			{ colors: ['#c68b67', '#cad988'], steps: 6 },
			// { colors: ['#c4ffad', '#a4f5ff'], steps: 2 },
			{ colors: ['#a4f5ff', '#5172be'], steps: 7 }
		],
		opacity: linearThenConstantWithThreshold(0.0001)
	},
	swell: {
		unit: 'm',
		min: 0,
		max: 10,
		steps: 50,
		colors: [
			{ colors: ['blue', 'green'], steps: 10 },
			{ colors: ['green', 'orange'], steps: 20 },
			{ colors: ['orange', 'red'], steps: 20 }
		]
	},
	swell_period: {
		unit: 's',
		min: 0,
		max: 20,
		steps: 20,
		colors: ['#a0614b', '#dfcd8c', '#34ad4a', '#2679be']
	},
	temperature: {
		unit: '°C',
		min: -80,
		max: 50,
		steps: 65,
		colors: [
			{ colors: ['#1af2dd', '#17658f'], steps: 15 }, // -80 to -50
			{ colors: ['#17658f', '#af0aaf'], steps: 10 }, // -50 to -30
			{ colors: ['#af0aaf', '#0034ff'], steps: 10 }, // -30 to -10
			{ colors: ['#0034ff', '#a4eef5'], steps: 5 }, // -10 to 0
			{ colors: ['#7cf57c', 'green'], steps: 7 }, // 0 to 14
			{ colors: ['green', 'yellow'], steps: 4 }, // 14 to 20
			{ colors: ['yellow', 'orange'], steps: 3 }, // 14 to 28
			{ colors: ['orange', 'red'], steps: 7 }, // 28 to 42
			{ colors: ['red', '#93001a'], steps: 4 } // 42 to 50
		]
	},
	temperature_2m_anomaly: {
		unit: 'K',
		min: -5,
		max: 5,
		steps: 20,
		colors: [
			{ colors: ['blue', 'white'], steps: 10 },
			{ colors: ['white', 'red'], steps: 10 }
		]
	},
	thunderstorm: {
		unit: '%',
		min: 0,
		max: 100,
		steps: 100,
		colors: [
			{ colors: ['blue', 'green'], steps: 33 },
			{ colors: ['green', 'orange'], steps: 33 },
			{ colors: ['orange', 'red'], steps: 34 }
		],
		opacity: powerScaleOpacity()
	},
	uv: {
		unit: '',
		min: 0,
		max: 12,
		steps: 12,
		colors: ['#009392', '#39b185', '#9ccb86', '#e9e29c', '#eeb479', '#e88471', '#cf597e']
	},
	vertical_velocity: {
		unit: 'm/s',
		min: -0.75,
		max: 0.75,
		steps: 20,
		colors: ['blue', 'white', 'red']
	},
	wind: {
		unit: 'm/s',
		min: 0,
		max: 60,
		steps: 40,
		colors: [
			{ colors: ['blue', 'green'], steps: 3 }, // 0 to 4.5 m/s
			{ colors: ['green', 'orange'], steps: 7 }, // 4.5 to 15 m/s
			{ colors: ['orange', 'red'], steps: 10 }, // 15 to 30 m/s
			{ colors: ['red', 'purple'], steps: 10 }, // 30 to 45 m/s
			{ colors: ['purple', '#740505'], steps: 10 } // 45 to 60 m/s
		],
		opacity: powerThenConstant(10 / 3.6, 4, 20, 1)
	}
};

function generateFromColorsInput(colorsInput: string[] | ColorSegment[], defaultSteps: number) {
	// If it's an array of ColorSegment objects (multi segment), build them
	if (Array.isArray(colorsInput) && colorsInput.length > 0 && typeof colorsInput[0] === 'object') {
		const segments = colorsInput as ColorSegment[];
		const out: [number, number, number][] = [];
		for (const seg of segments) {
			out.push(...interpolateColorScale(seg.colors, seg.steps, 'hsl'));
		}
		return out;
	}

	// Otherwise assume it's a simple string[] list of colors
	const colorStrings = colorsInput as string[];
	return interpolateColorScale(colorStrings, defaultSteps, 'hsl');
}

function generateColorScales(): Record<string, GeneratedColorScale> {
	const colorScales: Record<string, GeneratedColorScale> = {};

	// Helper function to generate a single color scale (supports dual/light-dark inputs)
	const generateSingleColorScale = (definition: ColorScaleDefinition): GeneratedColorScale => {
		const { steps, colors, opacity } = definition;

		// Dual (light/dark) input case
		if (colors && !Array.isArray(colors) && 'light' in colors && 'dark' in colors) {
			const lightGenerated = generateFromColorsInput(colors.light, steps);
			const darkGenerated = generateFromColorsInput(colors.dark, steps);

			return {
				...definition,
				colors: {
					light: lightGenerated,
					dark: darkGenerated
				},
				opacity
			};
		}

		// Single input case (string[] or ColorSegment[])
		const generated = generateFromColorsInput(colors as string[] | ColorSegment[], steps);

		return { ...definition, colors: generated, opacity };
	};

	// Generate base color scales
	for (const [key, definition] of Object.entries(colorScaleDefinitions)) {
		colorScales[key] = generateSingleColorScale(definition as ColorScaleDefinition);
	}

	return colorScales;
}

function serializeOpacity(opacity: string): string {
	if (!opacity) return '';
	return `\n\t\topacity: (${opacity}),`;
}

function generateTypeScript(): void {
	const colorScales = generateColorScales();

	let content = `import type { ColorScales } from '../types';

export const COLOR_SCALES: ColorScales = {`;
	for (const [key, colorScale] of Object.entries(colorScales)) {
		const { min, max, colors, unit, opacity } = colorScale;

		content += `
		'${key}': {
		type: 'alpha_resolvable',
		unit: '${unit}',
		min: ${min},
		max: ${max},
		`;

		// Colors can be either an array or an object with light/dark
		if (Array.isArray(colors)) {
			content += `colors: [`;
			for (const color of colors) {
				content += `\n			[${color[0]}, ${color[1]}, ${color[2]}],`;
			}
			content += `],`;
		} else {
			// object form
			content += `colors: { light: [`;
			for (const color of colors.light) {
				content += `[${color[0]}, ${color[1]}, ${color[2]}],`;
			}
			content += `], dark: [`;
			for (const color of colors.dark) {
				content += `[${color[0]}, ${color[1]}, ${color[2]}],`;
			}
			content += `],},`;
		}

		if (opacity) {
			content += serializeOpacity(opacity);
		}
		content += `
		},`;
	}
	content += `}`;

	const outputPath = join(__dirname, '../src/utils/color-scales.ts');
	writeFileSync(outputPath, content);
	console.log('✅ Generated color scales at:', outputPath);
}

generateTypeScript();

interface ColorSegment {
	colors: string[];
	steps: number;
}

type ColorInput =
	| string[]
	| ColorSegment[]
	| { light: string[] | ColorSegment[]; dark: string[] | ColorSegment[] };

interface ColorScaleDefinition {
	min: number;
	max: number;
	steps: number;
	colors: ColorInput;
	opacity?: string;
	unit: string;
}

// This represents the intermediate generated structure (before final serialization)
interface GeneratedColorScale {
	min: number;
	max: number;
	unit: string;
	colors: RGB[] | { light: RGB[]; dark: RGB[] };
	opacity?: string;
}
