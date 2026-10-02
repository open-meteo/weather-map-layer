import {
	defaultDerivationRules,
	variableHasDirections,
	variableSupportsBarbs
} from '../om-file-reader';
import type { VariableDerivationRule } from '../om-file-reader';
import { describe, expect, it } from 'vitest';

describe('variableHasDirections', () => {
	it('is true for variables the default rules derive directions for', () => {
		expect(variableHasDirections('wind_u_component_10m')).toBe(true);
		expect(variableHasDirections('wind_v_component_850hPa')).toBe(true);
		expect(variableHasDirections('ocean_u_current_velocity')).toBe(true);
		expect(variableHasDirections('wind_speed_10m')).toBe(true);
		expect(variableHasDirections('wind_direction_10m')).toBe(true);
		expect(variableHasDirections('wave_height')).toBe(true);
	});

	it('is false for scalar variables', () => {
		expect(variableHasDirections('temperature_2m')).toBe(false);
		expect(variableHasDirections('pressure_msl')).toBe(false);
		expect(variableHasDirections('wind_gusts_10m')).toBe(false);
	});

	it('follows the provides flag of a matching custom rule', () => {
		const scalarOnly: VariableDerivationRule = {
			pattern: 'temperature_anomaly',
			provides: { directions: false, barbs: false },
			scaleFactor: 'primary',
			getSourceVars: () => ['temperature_2m', 'temperature_2m_mean'],
			process: ([a, b]) => ({ values: a.map((v, i) => v - b[i]), directions: undefined })
		};
		expect(variableHasDirections('temperature_anomaly_2m', [scalarOnly])).toBe(false);
		expect(variableHasDirections('wind_u_component_10m', [scalarOnly])).toBe(false);
	});
});

describe('variableSupportsBarbs', () => {
	it('is true for wind speeds only', () => {
		expect(variableSupportsBarbs('wind_u_component_10m')).toBe(true);
		expect(variableSupportsBarbs('wind_speed_850hPa')).toBe(true);
		expect(variableSupportsBarbs('wind_direction_10m')).toBe(true);
	});

	it('is false for other direction-carrying quantities and scalars', () => {
		expect(variableSupportsBarbs('ocean_u_current_velocity')).toBe(false);
		expect(variableSupportsBarbs('wave_height')).toBe(false);
		expect(variableSupportsBarbs('swell_wave_direction')).toBe(false);
		expect(variableSupportsBarbs('temperature_2m')).toBe(false);
	});
});

describe('single-source rules', () => {
	// Snowfall in cm from the snowfall water equivalent in mm, the conversion
	// the Open-Meteo API applies: 1 mm of water melts from 0.7 cm of snow.
	const snowfallRule: VariableDerivationRule = {
		pattern: /^snowfall$/,
		provides: { directions: false, barbs: false },
		// The water equivalent is stored in 0.1 mm steps, so snowfall lands on a
		// 0.07 cm grid.
		scaleFactor: 1 / 0.07,
		getSourceVars: () => ['snowfall_water_equivalent'],
		process: ([waterEquivalent]) => ({
			values: waterEquivalent.map((mm) => mm * 0.7),
			directions: undefined
		})
	};
	const rules = [snowfallRule, ...defaultDerivationRules];

	it('converts the values of its single source variable', () => {
		const { values, directions } = snowfallRule.process([new Float32Array([0, 1, 10])]);
		expect(Array.from(values ?? [])).toEqual([
			expect.closeTo(0),
			expect.closeTo(0.7),
			expect.closeTo(7)
		]);
		expect(directions).toBeUndefined();
	});

	it('leaves the defaults in place when spread behind a custom rule', () => {
		expect(variableHasDirections('snowfall', rules)).toBe(false);
		expect(variableHasDirections('wind_u_component_10m', rules)).toBe(true);
		expect(variableSupportsBarbs('wind_speed_10m', rules)).toBe(true);
	});

	it('matches only the exact variable name, not the source variable', () => {
		const matching = (variable: string) =>
			rules.find((rule) =>
				typeof rule.pattern === 'string'
					? variable.includes(rule.pattern)
					: rule.pattern.test(variable)
			);
		expect(matching('snowfall')).toBe(snowfallRule);
		expect(matching('snowfall_water_equivalent')).toBeUndefined();
	});
});
