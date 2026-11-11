import {
	defaultDerivationRules,
	patternMatches,
	variableAvailable,
	variableHasDirections,
	variableSupportsBarbs,
	variableUsesDeltaTime
} from '../derivation-rules';
import type { VariableDerivationRule } from '../derivation-rules';
import { domainOptions } from '../domains';
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

	it('matches a global or sticky RegExp pattern on every lookup', () => {
		const vectors: VariableDerivationRule = {
			pattern: /_component_/g,
			provides: { directions: true, barbs: true },
			scaleFactor: 'primary',
			getSourceVars: () => ['wind_u_component_10m', 'wind_v_component_10m'],
			process: ([u]) => ({ values: u, directions: u })
		};
		// `RegExp.prototype.test` would advance `lastIndex` and fail every other call
		for (let i = 0; i < 3; i++) {
			expect(variableHasDirections('wind_u_component_10m', [vectors])).toBe(true);
		}
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

describe('variableAvailable', () => {
	it('is true for a stored variable and for one a default rule derives from the stored set', () => {
		const stored = new Set(['temperature_2m', 'relative_humidity_2m', 'snowfall_water_equivalent']);
		expect(variableAvailable('temperature_2m', stored)).toBe(true);
		expect(variableAvailable('snowfall', stored)).toBe(true);
		expect(variableAvailable('dew_point_2m', stored)).toBe(true);
		expect(variableAvailable('vapour_pressure_deficit', stored)).toBe(true);
	});

	it('is false where the sources are missing', () => {
		const stored = new Set(['temperature_2m', 'precipitation']);
		expect(variableAvailable('snowfall', stored)).toBe(false);
		expect(variableAvailable('apparent_temperature', stored)).toBe(false);
		expect(variableAvailable('rain', stored)).toBe(false);
	});
});

describe('variableUsesDeltaTime', () => {
	it('is true for the precipitation family and its ensemble statistics', () => {
		for (const variable of [
			'precipitation',
			'rain',
			'showers',
			'snowfall',
			'snowfall_water_equivalent',
			'precipitation_mean',
			'showers_spread'
		]) {
			expect(variableUsesDeltaTime(variable), variable).toBe(true);
		}
	});

	it('is false for what is not a per-step sum', () => {
		for (const variable of [
			'precipitation_probability',
			'snowfall_height',
			'snow_depth',
			'temperature_2m'
		]) {
			expect(variableUsesDeltaTime(variable), variable).toBe(false);
		}
	});
});

describe('wave directions', () => {
	const rule = defaultDerivationRules.find((r) => patternMatches(r.pattern, 'wave_direction'))!;
	const stored = new Set(['wave_height', 'wave_direction']);
	const height = new Float32Array([1.5, 2]);
	// Stored directions may sit in a signed range (the MF wave files hold -180..180)
	const direction = new Float32Array([-145, 350]);

	it('passes directions through for models storing where waves come from', () => {
		const domain = domainOptions.find((d) => d.value === 'ncep_gfswave025')!;
		const data = rule.process([height, direction], { variable: 'wave_direction', stored, domain });
		expect(Array.from(data.directions!)).toEqual([-145, 350]);
	});

	it('turns directions around for models storing where waves travel towards', () => {
		const domain = domainOptions.find((d) => d.value === 'meteofrance_wave')!;
		expect(domain.wave_directions_towards).toBe(true);
		const data = rule.process([height, direction], { variable: 'wave_direction', stored, domain });
		expect(Array.from(data.directions!)).toEqual([35, 170]);
		expect(data.values).toBe(height);
	});

	it('keeps directions as stored when the caller does not know the domain', () => {
		const data = rule.process([height, direction], { variable: 'wave_direction', stored });
		expect(Array.from(data.directions!)).toEqual([-145, 350]);
	});
});
