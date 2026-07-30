import { advectLonLat, advectLonLatRK2, computeParticleCount } from '../webgl/wind-math';
import { describe, expect, test } from 'vitest';

describe('WebGL wind integration', () => {
	test('moves cardinal vectors in the expected direction', () => {
		const east = advectLonLat(10, 50, 10, 0, 3600);
		const north = advectLonLat(10, 50, 0, 10, 3600);
		expect(east[0]).toBeGreaterThan(10);
		expect(east[1]).toBeCloseTo(50, 10);
		expect(north[0]).toBeCloseTo(10, 10);
		expect(north[1]).toBeGreaterThan(50);
	});

	test('accounts for longitude scale at high latitude', () => {
		const equator = advectLonLat(0, 0, 10, 0, 3600);
		const highLatitude = advectLonLat(0, 60, 10, 0, 3600);
		expect(highLatitude[0]).toBeCloseTo(equator[0] * 2, 5);
	});

	test('uses midpoint wind for a varying field', () => {
		const result = advectLonLatRK2(0, 0, 3600, (_longitude, latitude) => [10 + latitude * 100, 10]);
		const euler = advectLonLat(0, 0, 10, 10, 3600);
		expect(result[0]).toBeGreaterThan(euler[0]);
		expect(result[1]).toBeCloseTo(euler[1], 8);
	});

	test('is stable across frame rates for a constant field', () => {
		const integrate = (frames: number) => {
			let position: [number, number] = [5, 45];
			for (let index = 0; index < frames; index++) {
				position = advectLonLat(position[0], position[1], 8, 3, 3600 / frames);
			}
			return position;
		};
		const at30 = integrate(30);
		const at120 = integrate(120);
		expect(Math.abs(at30[0] - at120[0])).toBeLessThan(0.00001);
		expect(at30[1]).toBeCloseTo(at120[1], 10);
	});

	test('adapts particle count to viewport area and limits', () => {
		expect(computeParticleCount(1000, 500, 0.01)).toBe(5000);
		expect(computeParticleCount(100, 100, 0.01)).toBe(4096);
		expect(computeParticleCount(10000, 10000, 0.01)).toBe(65536);
	});
});
