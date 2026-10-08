import {
	apparentTemperature,
	dewPoint,
	relativeHumidity,
	vapourPressureDeficit,
	wetBulbTemperature
} from '../utils/meteorology';
import { describe, expect, it } from 'vitest';

// Reference values: the API's formulas (Meteorology.swift) evaluated in double
// precision.
describe('meteorology', () => {
	it('dew point by the Magnus formula', () => {
		expect(dewPoint(25, 60)).toBeCloseTo(16.6977, 3);
		expect(dewPoint(25, 100)).toBeCloseTo(25, 3);
	});

	it('relative humidity inverts the dew point, clamped to 0–100 %', () => {
		expect(relativeHumidity(25, dewPoint(25, 60))).toBeCloseTo(60, 3);
		expect(relativeHumidity(0, dewPoint(0, 95))).toBeCloseTo(95, 3);
		expect(relativeHumidity(20, 25)).toBe(100);
	});

	it('vapour pressure deficit, never negative', () => {
		expect(vapourPressureDeficit(25, dewPoint(25, 60))).toBeCloseTo(1.2669, 3);
		expect(vapourPressureDeficit(35, dewPoint(35, 20))).toBeCloseTo(4.4976, 3);
		expect(vapourPressureDeficit(25, 25)).toBe(0);
		expect(vapourPressureDeficit(20, 25)).toBe(0);
	});

	it('wet-bulb temperature, never above the air temperature', () => {
		expect(wetBulbTemperature(30, 70)).toBeCloseTo(25.5957, 3);
		expect(wetBulbTemperature(-5, 50)).toBeCloseTo(-7.7979, 3);
		expect(wetBulbTemperature(20, 100)).toBe(20);
	});

	it('apparent temperature with and without strong sunshine', () => {
		expect(apparentTemperature(30, 70, 5, 800)).toBeCloseTo(34.6989, 3);
		expect(apparentTemperature(30, 70, 5, 0)).toBeCloseTo(33.4262, 3);
		expect(apparentTemperature(0, 50, 10, 0)).toBeCloseTo(-8.4377, 3);
	});
});
