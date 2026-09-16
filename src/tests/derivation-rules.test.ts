import { variableHasDirections } from '../om-file-reader';
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
			provides: { directions: false },
			scaleFactor: 'primary',
			getSourceVars: () => ['temperature_2m', 'temperature_2m_mean'],
			process: (a, b) => ({ values: a.map((v, i) => v - b[i]), directions: undefined })
		};
		expect(variableHasDirections('temperature_anomaly_2m', [scalarOnly])).toBe(false);
		expect(variableHasDirections('wind_u_component_10m', [scalarOnly])).toBe(false);
	});
});
