import { radiansToDegrees } from '../utils/math';
import { renderSunShadow, solarPosition, sunElevationSine } from '../utils/sun';
import { describe, expect, test } from 'vitest';

const declinationDeg = (iso: string): number =>
	radiansToDegrees(solarPosition(Date.parse(iso)).declination);

describe('solarPosition', () => {
	test('declination is near zero at the equinoxes', () => {
		expect(Math.abs(declinationDeg('2025-03-20T09:01:00Z'))).toBeLessThan(0.1);
		expect(Math.abs(declinationDeg('2025-09-22T18:19:00Z'))).toBeLessThan(0.1);
	});

	test('declination reaches the tropics at the solstices', () => {
		expect(declinationDeg('2025-06-21T02:42:00Z')).toBeCloseTo(23.44, 1);
		expect(declinationDeg('2025-12-21T15:03:00Z')).toBeCloseTo(-23.44, 1);
	});

	test('reference value at the J2000 epoch', () => {
		// Astronomical Almanac: declination -23.03°, subsolar point slightly east
		// of Greenwich (equation of time roughly -3 minutes)
		const position = solarPosition(Date.parse('2000-01-01T12:00:00Z'));
		expect(radiansToDegrees(position.declination)).toBeCloseTo(-23.03, 1);
		expect(position.subsolarLongitude).toBeCloseTo(0.84, 1);
	});

	test('subsolar longitude follows earth rotation, 15 degrees per hour', () => {
		const noon = solarPosition(Date.parse('2025-08-05T12:00:00Z'));
		const later = solarPosition(Date.parse('2025-08-05T18:00:00Z'));
		// stays within the equation-of-time offset (max ~4 degrees) of the mean sun
		expect(Math.abs(noon.subsolarLongitude)).toBeLessThan(4.2);
		expect(later.subsolarLongitude - noon.subsolarLongitude).toBeCloseTo(-90, 1);
	});
});

describe('sunElevationSine', () => {
	test('is 1 at the subsolar point and -1 at the antipode', () => {
		const position = solarPosition(Date.parse('2025-08-05T12:00:00Z'));
		const subsolarLat = radiansToDegrees(position.declination);
		expect(sunElevationSine(subsolarLat, position.subsolarLongitude, position)).toBeCloseTo(1, 6);
		expect(sunElevationSine(-subsolarLat, position.subsolarLongitude + 180, position)).toBeCloseTo(
			-1,
			6
		);
	});

	test('is 0 on the terminator, 90 degrees from the subsolar point at equinox', () => {
		const position = solarPosition(Date.parse('2025-03-20T09:01:00Z'));
		expect(sunElevationSine(0, position.subsolarLongitude + 90, position)).toBeCloseTo(0, 2);
	});
});

describe('renderSunShadow', () => {
	const options = { opacity: 0.5, gradient: 6, color: [10, 20, 30] as [number, number, number] };

	test('day side transparent, night side at full configured opacity', () => {
		// z0 world tile: left half night, right half day around 12z (subsolar ~0°)
		const time = Date.parse('2025-08-05T12:00:00Z');
		const tileSize = 64;
		const rgba = new Uint8ClampedArray(tileSize * tileSize * 4);
		renderSunShadow(rgba, tileSize, 0, 0, 0, { time, ...options });

		const alphaAt = (i: number, j: number) => rgba[4 * (j + i * tileSize) + 3];
		const midRow = tileSize / 2;
		// tile centre (lon 0, lat 0) is close to the subsolar point -> day
		expect(alphaAt(midRow, tileSize / 2)).toBe(0);
		// the antimeridian at the equator is deep night
		expect(alphaAt(midRow, 0)).toBe(Math.round(255 * options.opacity));
		expect(rgba[4 * midRow * tileSize]).toBe(options.color[0]);
		expect(rgba[4 * midRow * tileSize + 2]).toBe(options.color[2]);
	});

	test('alpha ramps across the twilight zone', () => {
		const time = Date.parse('2025-03-20T12:00:00Z');
		const tileSize = 256;
		const rgba = new Uint8ClampedArray(tileSize * tileSize * 4);
		renderSunShadow(rgba, tileSize, 0, 0, 0, { time, ...options });

		// walk the equator row: alpha values should include intermediate levels
		const midRow = tileSize / 2;
		const alphas = new Set<number>();
		for (let j = 0; j < tileSize; j++) {
			alphas.add(rgba[4 * (j + midRow * tileSize) + 3]);
		}
		expect(alphas.has(0)).toBe(true);
		expect(alphas.has(Math.round(255 * options.opacity))).toBe(true);
		expect(alphas.size).toBeGreaterThan(3);
	});

	test('gradient 0 gives a hard edge with no intermediate alpha', () => {
		const time = Date.parse('2025-03-20T12:00:00Z');
		const tileSize = 256;
		const rgba = new Uint8ClampedArray(tileSize * tileSize * 4);
		renderSunShadow(rgba, tileSize, 0, 0, 0, { time, ...options, gradient: 0 });

		const midRow = tileSize / 2;
		for (let j = 0; j < tileSize; j++) {
			const alpha = rgba[4 * (j + midRow * tileSize) + 3];
			expect(alpha === 0 || alpha === Math.round(255 * options.opacity)).toBe(true);
		}
	});
});
