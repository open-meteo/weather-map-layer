import { color } from 'd3-color';
import { interpolateHsl, interpolateRgb } from 'd3-interpolate';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { type ColorScale as GeneratedColorScale } from '../src/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ColorScaleDefinition {
	min: number;
	max: number;
	steps: number;
	colors: string[] | ColorSegment[];
	interpolationMethod: 'linear' | 'none';
	unit: string;
}

interface ColorSegment {
	colors: string[];
	steps: number;
}

interface AliasConfig {
	source: string;
}

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

const colorScaleDefinitions: Record<string, ColorScaleDefinition> = {
	cape: {
		min: 0,
		max: 4000,
		steps: 100,
		colors: ['#009392', '#39b185', '#9ccb86', '#e9e29c', '#eeb479', '#e88471', '#cf597e'],
		interpolationMethod: 'linear',
		unit: ''
	},
	cloud_base: {
		min: 0,
		max: 20900,
		steps: 100,
		colors: ['#FFF', '#c3c2c2'],
		interpolationMethod: 'linear',
		unit: 'm'
	},
	cloud_cover: {
		min: 0,
		max: 100,
		steps: 100,
		colors: ['#FFF', '#c3c2c2'],
		interpolationMethod: 'linear',
		unit: '%'
	},
	convective_cloud_top: {
		min: 0,
		max: 6000,
		steps: 100,
		colors: ['#c0392b', '#d35400', '#f1c40f', '#16a085', '#2980b9'],
		interpolationMethod: 'none',
		unit: 'm'
	},
	precipitation: {
		min: 0,
		max: 20,
		steps: 20,
		colors: [
			{ colors: ['blue', 'green'], steps: 5 },
			{ colors: ['green', 'orange'], steps: 5 },
			{ colors: ['orange', 'red'], steps: 10 }
		],
		interpolationMethod: 'linear',
		unit: 'mm'
	},
	pressure: {
		min: 950,
		max: 1050,
		steps: 50,
		colors: ['#4444FF', '#FFFFFF', '#FF4444'],
		interpolationMethod: 'linear',
		unit: 'hPa'
	},
	relative: {
		min: 0,
		max: 100,
		steps: 100,
		colors: ['#009392', '#39b185', '#9ccb86', '#e9e29c', '#eeb479', '#e88471', '#cf597e'].reverse(),
		interpolationMethod: 'linear',
		unit: '%'
	},
	shortwave: {
		min: 0,
		max: 1000,
		steps: 100,
		colors: ['#009392', '#39b185', '#9ccb86', '#e9e29c', '#eeb479', '#e88471', '#cf597e'],
		interpolationMethod: 'linear',
		unit: 'W/m^2'
	},
	temperature: {
		min: -40,
		max: 60,
		steps: 100,
		colors: [
			{ colors: ['purple', 'blue'], steps: 40 },
			{ colors: ['blue', 'green'], steps: 16 },
			{ colors: ['green', 'orange'], steps: 12 },
			{ colors: ['orange', 'red'], steps: 14 },
			{ colors: ['red', 'purple'], steps: 18 }
		],
		interpolationMethod: 'linear',
		unit: 'C°'
	},
	temperature_2m_anomaly: {
		min: -5,
		max: 5,
		steps: 20,
		colors: [
			{ colors: ['blue', 'white'], steps: 10 },
			{ colors: ['white', 'red'], steps: 10 }
		],
		interpolationMethod: 'linear',
		unit: 'K'
	},
	thunderstorm: {
		min: 0,
		max: 100,
		steps: 100,
		colors: [
			{ colors: ['blue', 'green'], steps: 33 },
			{ colors: ['green', 'orange'], steps: 33 },
			{ colors: ['orange', 'red'], steps: 34 }
		],
		interpolationMethod: 'linear',
		unit: '%'
	},
	swell: {
		min: 0,
		max: 10,
		steps: 50,
		colors: [
			{ colors: ['blue', 'green'], steps: 10 }, // 0 to 2m
			{ colors: ['green', 'orange'], steps: 20 }, // 2 to 6m
			{ colors: ['orange', 'red'], steps: 20 } // 6 to 10m
		],
		interpolationMethod: 'linear',
		unit: 'm'
	},
	uv: {
		min: 0,
		max: 12,
		steps: 12,
		colors: ['#009392', '#39b185', '#9ccb86', '#e9e29c', '#eeb479', '#e88471', '#cf597e'],
		interpolationMethod: 'linear',
		unit: ''
	},
	wind: {
		min: 0,
		max: 70,
		steps: 40,
		colors: [
			{ colors: ['blue', 'green'], steps: 10 }, // 0 to 10kn
			{ colors: ['green', 'orange'], steps: 10 }, // 10 to 20kn
			{ colors: ['orange', 'red'], steps: 20 } // 20 to 40kn
		],
		interpolationMethod: 'linear',
		unit: 'km/h'
	}
};

const aliases: Record<string, AliasConfig> = {
	// Simple aliases (exact copy)
	rain: {
		source: 'precipitation'
	},
	convective_cloud_base: {
		source: 'convective_cloud_top'
	},
	wave: {
		source: 'swell'
	}
};

function generateColorScales(): Record<string, GeneratedColorScale> {
	const colorScales: Record<string, GeneratedColorScale> = {};

	// Helper function to generate a single color scale
	function generateSingleColorScale(definition: ColorScaleDefinition): GeneratedColorScale {
		const { min, max, steps, colors, interpolationMethod, unit } = definition;

		let generatedColors: [number, number, number][];

		if (
			Array.isArray(colors) &&
			colors.length > 0 &&
			typeof colors[0] === 'object' &&
			'colors' in colors[0]
		) {
			// Handle ColorSegment[] - multi-segment color scales
			const segments = colors as ColorSegment[];
			generatedColors = [];

			for (const segment of segments) {
				const segmentColors = interpolateColorScale(segment.colors, segment.steps, 'hsl');
				generatedColors.push(...segmentColors);
			}
		} else {
			// Handle string[] - simple color array
			const colorStrings = colors as string[];
			generatedColors = interpolateColorScale(colorStrings, steps, 'hsl');
		}

		return {
			min,
			max,
			steps,
			scalefactor: steps / (max - min),
			colors: generatedColors,
			interpolationMethod,
			unit
		};
	}

	// Generate base color scales
	Object.entries(colorScaleDefinitions).forEach(([key, definition]) => {
		colorScales[key] = generateSingleColorScale(definition);
	});

	// Generate aliases
	Object.entries(aliases).forEach(([aliasName, aliasConfig]) => {
		const { source } = aliasConfig;

		// Get the source (could be a base definition or another alias)
		const sourceColorScale = colorScales[source];
		if (!sourceColorScale) {
			throw new Error(`Source color scale '${source}' not found for alias '${aliasName}'`);
		}
		// Simple copy
		colorScales[aliasName] = { ...sourceColorScale };
	});

	return colorScales;
}

function generateTypeScript(): void {
	const colorScales = generateColorScales();

	const content = `import type { ColorScales } from '../types';

export const colorScales: ColorScales = ${JSON.stringify(colorScales, null, '\t')};
`;

	const outputPath = join(__dirname, '../src/utils/color-scales.ts');
	writeFileSync(outputPath, content);
	console.log('✅ Generated color scales at:', outputPath);
}

generateTypeScript();
