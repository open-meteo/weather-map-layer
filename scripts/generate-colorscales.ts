import { color } from 'd3-color';
import { interpolateHsl } from 'd3-interpolate';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type RGBA = [number, number, number, number];
type RGB = [number, number, number];

// A color segment defines colors over a value range
interface ColorSegment {
	range: [number, number]; // [start, end] values
	colors: string[]; // colors to interpolate between
}

// Color segments can be a single array (same for both modes) or separate light/dark
type ColorSegmentsDefinition = ColorSegment[] | { light: ColorSegment[]; dark: ColorSegment[] };

// An opacity segment defines opacity over a value range
interface OpacitySegment {
	range: [number, number];
	opacity: [number, number]; // [start, end] opacity values
	easing?: 'linear' | 'power' | 'power-inverse'; // how to interpolate
	exponent?: number; // for power easing
}

// Opacity segments can also be mode-specific
type OpacitySegmentsDefinition =
	| OpacitySegment[]
	| { light: OpacitySegment[]; dark: OpacitySegment[] };

interface ColorScaleDefinition {
	unit: string;
	breakpoints: number[];
	colorSegments: ColorSegmentsDefinition;
	opacitySegments?: OpacitySegmentsDefinition;
}

// Interpolate a color at a specific position within a segment
function interpolateColorAt(segment: ColorSegment, value: number): RGB {
	const { range, colors } = segment;
	const t = Math.max(0, Math.min(1, (value - range[0]) / (range[1] - range[0])));

	// If only 2 colors, simple interpolation
	if (colors.length === 2) {
		const interpolate = interpolateHsl(colors[0], colors[1]);
		const c = color(interpolate(t))!.rgb();
		return [Math.round(c.r), Math.round(c.g), Math.round(c.b)];
	}

	// Multiple colors: find which sub-segment we're in
	const segments = colors.length - 1;
	const segmentSize = 1 / segments;
	const segmentIndex = Math.min(Math.floor(t / segmentSize), segments - 1);
	const segmentT = (t - segmentIndex * segmentSize) / segmentSize;

	const interpolate = interpolateHsl(colors[segmentIndex], colors[segmentIndex + 1]);
	const c = color(interpolate(segmentT))!.rgb();
	return [Math.round(c.r), Math.round(c.g), Math.round(c.b)];
}

// Interpolate opacity at a specific position within a segment
function interpolateOpacityAt(segment: OpacitySegment, value: number): number {
	const { range, opacity, easing = 'linear', exponent = 2 } = segment;
	let t = Math.max(0, Math.min(1, (value - range[0]) / (range[1] - range[0])));

	// Apply easing
	switch (easing) {
		case 'power':
			t = Math.pow(t, exponent);
			break;
		case 'power-inverse':
			t = 1 - Math.pow(1 - t, exponent);
			break;
		case 'linear':
		default:
			break;
	}

	return opacity[0] + t * (opacity[1] - opacity[0]);
}

// Find the color at a given value by finding the appropriate segment
function getColorAt(colorSegments: ColorSegment[], value: number): RGB {
	// Find the segment that contains this value
	for (const segment of colorSegments) {
		if (value >= segment.range[0] && value < segment.range[1]) {
			return interpolateColorAt(segment, value);
		}
	}
	// If value is below all segments, use first segment's start
	if (value < colorSegments[0].range[0]) {
		return interpolateColorAt(colorSegments[0], colorSegments[0].range[0]);
	}
	// If value is above all segments, use last segment's end
	const lastSegment = colorSegments[colorSegments.length - 1];
	return interpolateColorAt(lastSegment, lastSegment.range[1]);
}

// Find the opacity at a given value by finding the appropriate segment
function getOpacityAt(opacitySegments: OpacitySegment[] | null, value: number): number {
	if (!opacitySegments) return 1;
	// Find the segment that contains this value
	for (const segment of opacitySegments) {
		if (value >= segment.range[0] && value <= segment.range[1]) {
			return interpolateOpacityAt(segment, value);
		}
	}
	// If value is below all segments, use first segment's start opacity
	if (value < opacitySegments[0].range[0]) {
		return opacitySegments[0].opacity[0];
	}
	// If value is above all segments, use last segment's end opacity
	const lastSegment = opacitySegments[opacitySegments.length - 1];
	return lastSegment.opacity[1];
}

// Check if color segments have light/dark variants
function hasColorVariants(
	segments: ColorSegmentsDefinition
): segments is { light: ColorSegment[]; dark: ColorSegment[] } {
	return !Array.isArray(segments) && 'light' in segments && 'dark' in segments;
}

// Check if opacity segments have light/dark variants
function hasOpacityVariants(
	segments?: OpacitySegmentsDefinition
): segments is { light: OpacitySegment[]; dark: OpacitySegment[] } {
	if (!segments) return false;
	return !Array.isArray(segments) && 'light' in segments && 'dark' in segments;
}

// Get color segments for a specific mode
function getColorSegments(
	segments: ColorSegmentsDefinition,
	mode: 'light' | 'dark'
): ColorSegment[] {
	if (hasColorVariants(segments)) {
		return segments[mode];
	}
	return segments;
}

// Get opacity segments for a specific mode
function getOpacitySegments(
	mode: 'light' | 'dark',
	segments?: OpacitySegmentsDefinition
): OpacitySegment[] | null {
	if (!segments) return null;
	if (hasOpacityVariants(segments)) {
		return segments[mode];
	}
	return segments;
}

// Generate RGBA colors at each breakpoint for a specific mode
function generateColorsAtBreakpoints(
	definition: ColorScaleDefinition,
	mode: 'light' | 'dark'
): RGBA[] {
	const { breakpoints, colorSegments, opacitySegments } = definition;
	const colorSegs = getColorSegments(colorSegments, mode);
	const opacitySegs = getOpacitySegments(mode, opacitySegments);

	return breakpoints.map((value) => {
		const rgb = getColorAt(colorSegs, value);
		const opacity = getOpacityAt(opacitySegs, value);
		return [rgb[0], rgb[1], rgb[2], Number(opacity.toFixed(3))];
	});
}

// Check if a definition needs separate light/dark outputs
function needsVariants(definition: ColorScaleDefinition): boolean {
	return (
		hasColorVariants(definition.colorSegments) || hasOpacityVariants(definition.opacitySegments)
	);
}

// Color scale definitions
const colorScaleDefinitions: Record<string, ColorScaleDefinition> = {
	albedo: {
		unit: '%',
		breakpoints: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90],
		colorSegments: [
			{ range: [0, 10], colors: ['#add8e6', '#004011'] },
			{ range: [10, 25], colors: ['#004011', '#937350'] },
			{ range: [25, 100], colors: ['#937350', '#ffffff'] }
		]
	},
	cape: {
		unit: 'J/kg',
		breakpoints: [0, 50, 150, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 3500, 4000],
		colorSegments: [
			{ range: [0, 2000], colors: ['#008000', '#ffff00', '#ffa500'] },
			{ range: [2000, 4000], colors: ['#ffa500', '#ff0000'] }
		],
		opacitySegments: [{ range: [0, 500], opacity: [0, 1], easing: 'linear' }]
	},
	cloud_cover: {
		unit: '%',
		breakpoints: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90],
		colorSegments: {
			light: [{ range: [0, 100], colors: ['#ffffff', '#f1f5f9', '#d1d5db', '#9ca3af', '#4b5563'] }],
			dark: [{ range: [0, 100], colors: ['#0b1220', '#4b5563', '#9ca3af', '#d1d5db', '#f1f5f9'] }]
		},
		opacitySegments: [
			{ range: [0, 20], opacity: [0, 0.4], easing: 'power', exponent: 1.5 },
			{ range: [20, 100], opacity: [0.4, 1], easing: 'linear' }
		]
	},
	convective_inhibition: {
		unit: 'J/kg',
		breakpoints: [0, 25, 50, 100, 150, 200, 300, 400, 500],
		colorSegments: [
			{ range: [0, 100], colors: ['#ffffff', '#800080', '#40e0d0'] },
			{ range: [100, 300], colors: ['#40e0d0', '#008000', '#ffa500'] },
			{ range: [300, 500], colors: ['#ffa500', '#ff0000', '#f5f5dc'] }
		],
		opacitySegments: [{ range: [0, 500], opacity: [0.5, 1], easing: 'linear' }]
	},
	convective_cloud_top: {
		unit: 'm',
		breakpoints: [0, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6200],
		colorSegments: [
			{ range: [0, 6200], colors: ['#c0392b', '#d35400', '#f1c40f', '#16a085', '#2980b9'] }
		],
		opacitySegments: [
			{ range: [0, 1000], opacity: [0, 0.3], easing: 'linear' },
			{ range: [1000, 3000], opacity: [0.3, 0.6], easing: 'linear' },
			{ range: [3000, 6200], opacity: [0.6, 1], easing: 'linear' }
		]
	},
	geopotential_height: {
		unit: 'm',
		breakpoints: [4600, 4800, 5000, 5100, 5200, 5300, 5400, 5500, 5600, 5800, 6000],
		colorSegments: [
			{
				range: [4600, 6000],
				colors: ['#2E8B7A', '#5A3E8A', '#003366', '#006400', '#B5A000', '#550000']
			}
		],
		opacitySegments: [{ range: [4600, 6000], opacity: [0.7, 0.7], easing: 'linear' }]
	},
	precipitation: {
		unit: 'mm',
		breakpoints: [0.01, 0.055, 0.2, 1, 2, 4, 8, 12, 16, 20, 25, 30],
		colorSegments: [
			{ range: [0, 0.04], colors: ['#d1eeff', '#87cefa'] },
			{ range: [0.04, 2], colors: ['#87cefa', '#0060e9'] },
			{ range: [2, 4], colors: ['#0060e9', '#388e3c'] },
			{ range: [4, 8], colors: ['#388e3c', '#fdff00'] },
			{ range: [8, 12], colors: ['#fdff00', '#ff8c00'] },
			{ range: [12, 16], colors: ['#ff8c00', '#ff3131'] },
			{ range: [16, 30], colors: ['#ff3131', '#9c27b0'] }
		],
		opacitySegments: [
			{ range: [0, 0.055], opacity: [0, 0.5], easing: 'linear' },
			{ range: [0.055, 0.11], opacity: [0.5, 0.7], easing: 'linear' },
			{ range: [0.11, 0.95], opacity: [0.7, 0.8], easing: 'linear' },
			{ range: [0.95, 2], opacity: [0.8, 1], easing: 'power-inverse', exponent: 2 }
		]
	},
	precipitation_probability: {
		unit: '%',
		breakpoints: [0.1, 0.2, 0.3, 0.6, 1, 3, 6, 9, 15, 22, 30, 45, 60, 75, 100],
		colorSegments: [
			{ range: [0, 0.5], colors: ['#000000', '#87CEFA'] },
			{ range: [0.5, 10], colors: ['#87CEFA', '#5b95e6'] },
			{ range: [10, 33], colors: ['#5b95e6', '#FFDD00'] },
			{ range: [33, 100], colors: ['#FFDD00', '#ff0000'] }
		],
		opacitySegments: [
			{ range: [0, 1], opacity: [0, 0.2], easing: 'linear' },
			{ range: [1, 3], opacity: [0.2, 0.3], easing: 'linear' },
			{ range: [3, 10], opacity: [0.3, 0.5], easing: 'linear' },
			{ range: [10, 25], opacity: [0.5, 0.8], easing: 'linear' },
			{ range: [10, 100], opacity: [0.6, 1], easing: 'power-inverse', exponent: 2 }
		]
	},
	pressure: {
		unit: 'hPa',
		breakpoints: [
			940, 950, 960, 970, 980, 990, 995, 1000, 1005, 1010, 1015, 1020, 1025, 1030, 1040, 1050, 1060
		],
		colorSegments: [
			{ range: [940, 1010], colors: ['#4444ff', '#ffffff'] },
			{ range: [1010, 1060], colors: ['#ffffff', '#ff4444'] }
		],
		opacitySegments: [{ range: [950, 1050], opacity: [1, 1], easing: 'linear' }]
	},
	relative: {
		unit: '%',
		breakpoints: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95],
		colorSegments: [
			{
				range: [0, 100],
				colors: ['#cf597e', '#e88471', '#eeb479', '#e9e29c', '#9ccb86', '#39b185', '#009392']
			}
		],
		opacitySegments: [{ range: [0, 100], opacity: [1, 1], easing: 'linear' }]
	},
	shortwave: {
		unit: 'W/m²',
		breakpoints: [0, 50, 100, 150, 200, 300, 400, 500, 600, 700, 800, 900, 1000],
		colorSegments: [
			{
				range: [0, 1000],
				colors: ['#009392', '#39b185', '#9ccb86', '#e9e29c', '#eeb479', '#e88471', '#cf597e']
			}
		],
		opacitySegments: [{ range: [0, 1000], opacity: [1, 1], easing: 'linear' }]
	},
	snow_depth: {
		unit: 'm',
		breakpoints: [0, 0.01, 0.05, 0.1, 0.2, 0.5, 1, 1.5, 2, 3, 4, 5],
		colorSegments: [
			{ range: [0, 1.5], colors: ['#008000', '#ffff00'] },
			{ range: [1.5, 3.5], colors: ['#ffff00', '#ff0000'] },
			{ range: [3.5, 5], colors: ['#ff0000', '#800080'] }
		],
		opacitySegments: [
			{ range: [0, 0.01], opacity: [0, 1], easing: 'linear' },
			{ range: [0.01, 5], opacity: [1, 1], easing: 'linear' }
		]
	},
	soil_moisture: {
		unit: 'vol. %',
		breakpoints: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5],
		colorSegments: [
			{ range: [0, 0.15], colors: ['#e8c88a', '#c68b67'] },
			{ range: [0.15, 0.3], colors: ['#c68b67', '#cad988'] },
			{ range: [0.3, 0.5], colors: ['#a4f5ff', '#5172be'] }
		],
		opacitySegments: [
			{ range: [0, 0.0001], opacity: [0, 1], easing: 'linear' },
			{ range: [0.0001, 0.5], opacity: [1, 1], easing: 'linear' }
		]
	},
	swell: {
		unit: 'm',
		breakpoints: [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9, 10],
		colorSegments: [
			{ range: [0, 2], colors: ['#0000ff', '#008000'] },
			{ range: [2, 6], colors: ['#008000', '#ffa500'] },
			{ range: [6, 10], colors: ['#ffa500', '#ff0000'] }
		],
		opacitySegments: [{ range: [0, 10], opacity: [0.7, 0.7], easing: 'linear' }]
	},
	swell_period: {
		unit: 's',
		breakpoints: [0, 3, 5, 7, 9, 11, 13, 15, 17, 20],
		colorSegments: [{ range: [0, 20], colors: ['#a0614b', '#dfcd8c', '#34ad4a', '#2679be'] }],
		opacitySegments: [{ range: [0, 20], opacity: [1, 1], easing: 'linear' }]
	},
	temperature: {
		unit: '°C',
		breakpoints: [
			-80, -70, -60, -50, -40, -36, -32, -28, -24, -20, -17.5, -15, -12.5, -10, -8, -6, -4, -2, 0,
			2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50
		],
		colorSegments: [
			{ range: [-80, -50], colors: ['#000000', '#ffffff'] },
			{ range: [-50, -30], colors: ['#ffffff', '#c535dc'] },
			{ range: [-30, -10], colors: ['#c535dc', '#0034ff'] },
			{ range: [-10, 0], colors: ['#0034ff', '#a4eef5'] },
			{ range: [0, 8], colors: ['#23ff3e', 'green'] },
			{ range: [8, 16], colors: ['green', 'yellow'] },
			// { range: [14, 20], colors: ['green', 'yellow'] },
			{ range: [16, 24], colors: ['yellow', 'orange'] },
			{ range: [24, 32], colors: ['orange', 'red'] },
			{ range: [32, 42], colors: ['red', 'brown'] },
			{ range: [42, 50], colors: ['brown', 'pink'] }
		],
		opacitySegments: [{ range: [-80, 50], opacity: [1, 1], easing: 'linear' }]
	},
	temperature_2m_anomaly: {
		unit: 'K',
		breakpoints: [-5, -4, -3, -2, -1, 0.5, 0, 0.5, 1, 2, 3, 4, 5],
		colorSegments: [
			{ range: [-5, 0.0], colors: ['#0000ff', '#ffffff'] },
			{ range: [0.0, 5], colors: ['#ffffff', '#ff0000'] }
		],
		opacitySegments: [
			{ range: [-5, 0], opacity: [1, 0], easing: 'power-inverse', exponent: 0.5 },
			{ range: [0, 5], opacity: [0, 1], easing: 'power', exponent: 0.5 }
		]
	},
	thunderstorm: {
		unit: '%',
		breakpoints: [0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90],
		colorSegments: [
			{ range: [0, 33], colors: ['#0000ff', '#008000'] },
			{ range: [33, 66], colors: ['#008000', '#ffa500'] },
			{ range: [66, 100], colors: ['#ffa500', '#ff0000'] }
		],
		opacitySegments: [{ range: [0, 100], opacity: [0, 1], easing: 'power', exponent: 1.5 }]
	},
	uv: {
		unit: '',
		breakpoints: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
		colorSegments: [
			{
				range: [0, 12],
				colors: ['#009392', '#39b185', '#9ccb86', '#e9e29c', '#eeb479', '#e88471', '#cf597e']
			}
		],
		opacitySegments: [{ range: [0, 12], opacity: [1, 1], easing: 'linear' }]
	},
	vertical_velocity: {
		unit: 'm/s',
		breakpoints: [-0.75, -0.5, -0.3, -0.15, -0.05, 0, 0.05, 0.15, 0.3, 0.5, 0.75],
		colorSegments: [
			{ range: [-0.75, 0], colors: ['#0000ff', '#ffffff'] },
			{ range: [0, 0.75], colors: ['#ffffff', '#ff0000'] }
		],
		opacitySegments: [
			{ range: [-0.75, 0], opacity: [1, 0], easing: 'power-inverse', exponent: 1.5 },
			{ range: [0, 0.75], opacity: [0, 1], easing: 'power', exponent: 1.5 }
		]
	},
	wind: {
		unit: 'm/s',
		breakpoints: [
			0, 0.3, 0.6, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12.5, 15, 17.5, 20, 25, 30, 40, 50, 60
		],
		colorSegments: [
			{ range: [0, 5], colors: ['steelblue', 'green'] }, // 0 to 5m/s
			{ range: [5, 14], colors: ['green', 'orange'] }, // 5 to 15m/s
			{ range: [14, 28], colors: ['orange', '#ff0000'] }, // 14 to 28m/s
			{ range: [28, 45], colors: ['#ff0000', '#800080'] },
			{ range: [45, 60], colors: ['#800080', '#740505'] }
		],
		opacitySegments: [
			{ range: [0, 0.3], opacity: [0, 0.1], easing: 'linear' },
			{ range: [0.3, 1], opacity: [0.1, 0.2], easing: 'linear' },

			{ range: [1, 7], opacity: [0.2, 1], easing: 'linear' },
			{ range: [7, 60], opacity: [1, 1], easing: 'linear' }
		]
	}
};
interface GeneratedColorScale {
	unit: string;
	breakpoints: number[];
	colors: RGBA[] | { light: RGBA[]; dark: RGBA[] };
}

function generateColorScales(): Record<string, GeneratedColorScale> {
	const colorScales: Record<string, GeneratedColorScale> = {};

	for (const [key, definition] of Object.entries(colorScaleDefinitions)) {
		const { unit, breakpoints } = definition;

		if (needsVariants(definition)) {
			// Generate separate light and dark colors
			const lightColors = generateColorsAtBreakpoints(definition, 'light');
			const darkColors = generateColorsAtBreakpoints(definition, 'dark');
			colorScales[key] = {
				unit,
				breakpoints,
				colors: { light: lightColors, dark: darkColors }
			};
		} else {
			// Single color array for both modes
			const colors = generateColorsAtBreakpoints(definition, 'light');
			colorScales[key] = {
				unit,
				breakpoints,
				colors
			};
		}
	}

	return colorScales;
}

function serializeRGBAArray(colors: RGBA[], indent: string): string {
	let content = '[';
	for (const c of colors) {
		content += `\n${indent}[${c[0]}, ${c[1]}, ${c[2]}, ${c[3]}],`;
	}
	content += `\n${indent.slice(0, -1)}]`;
	return content;
}

function generateTypeScript(): void {
	const colorScales = generateColorScales();

	let content = `import type { ColorScales } from '../types';

export const COLOR_SCALES: ColorScales = {`;

	for (const [key, colorScale] of Object.entries(colorScales)) {
		const { unit, breakpoints, colors } = colorScale;

		const hasVariants = !Array.isArray(colors);

		content += `
	'${key}': {
		type: 'breakpoint',
		unit: '${unit}',
		breakpoints: [${breakpoints.join(', ')}],`;

		if (hasVariants) {
			content += `
		colors: {
			light: ${serializeRGBAArray(colors.light, '\t\t\t\t')},
			dark: ${serializeRGBAArray(colors.dark, '\t\t\t\t')},
		},`;
		} else {
			content += `
		colors: ${serializeRGBAArray(colors, '\t\t\t')},`;
		}

		content += `
	},`;
	}

	content += `
};
`;

	const outputPath = join(__dirname, '../src/utils/color-scales.ts');
	writeFileSync(outputPath, content);
	console.log('✅ Generated breakpoint color scales at:', outputPath);
}

generateTypeScript();
