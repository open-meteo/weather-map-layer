import { degreesToRadians, radiansToDegrees, tile2lat, tile2lon } from './math';

import type { SunShadowOptions } from '../types';

// 2000-01-01T12:00Z, the J2000.0 epoch all terms below are referenced to.
const J2000_EPOCH_MS = 946728000000;

export interface SolarPosition {
	// Solar declination in radians (latitude of the subsolar point).
	declination: number;
	// Longitude of the subsolar point in degrees, [-180, 180).
	subsolarLongitude: number;
}

/**
 * Analytical solar position from the low-precision formulas of the
 * Astronomical Almanac (also used by NOAA). Accurate to a few hundredths of a
 * degree between 1950 and 2050 — far below a pixel at overlay resolution.
 */
export const solarPosition = (timeMs: number): SolarPosition => {
	const days = (timeMs - J2000_EPOCH_MS) / 86400000;

	const meanAnomaly = degreesToRadians(357.529 + 0.98560028 * days);
	const meanLongitude = 280.459 + 0.98564736 * days;
	const eclipticLongitude = degreesToRadians(
		meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)
	);
	const obliquity = degreesToRadians(23.439 - 0.00000036 * days);

	const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
	const rightAscension = radiansToDegrees(
		Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude))
	);

	// Greenwich mean sidereal time fixes the sub-solar longitude on the rotating earth
	const siderealTime = 280.46061837 + 360.98564736629 * days;
	const subsolarLongitude = normalizeTo180(rightAscension - siderealTime);

	return { declination, subsolarLongitude };
};

const normalizeTo180 = (degrees: number): number => (((degrees % 360) + 540) % 360) - 180;

/** Sine of the sun's elevation angle at a location, for testing and popups. */
export const sunElevationSine = (lat: number, lon: number, position: SolarPosition): number => {
	const latRad = degreesToRadians(lat);
	const hourAngle = degreesToRadians(lon - position.subsolarLongitude);
	return (
		Math.sin(latRad) * Math.sin(position.declination) +
		Math.cos(latRad) * Math.cos(position.declination) * Math.cos(hourAngle)
	);
};

/**
 * Fills a tile's rgba buffer with the night-side shadow. Alpha ramps with a
 * smoothstep from 0 at the terminator (solar elevation 0°) to `opacity` at
 * elevation -`gradient`°, so `gradient: 0` gives a hard day/night edge and
 * e.g. 6/12/18 correspond to civil/nautical/astronomical twilight.
 */
export const renderSunShadow = (
	rgba: Uint8ClampedArray,
	tileSize: number,
	z: number,
	x: number,
	y: number,
	options: SunShadowOptions
): void => {
	const position = solarPosition(options.time);
	const sinDeclination = Math.sin(position.declination);
	const cosDeclination = Math.cos(position.declination);
	const sinElevationFull = Math.sin(degreesToRadians(-Math.max(options.gradient, 0)));

	const [r, g, b] = options.color;
	const maxAlpha = 255 * options.opacity;

	// sin(elevation) = sin(lat)sin(dec) + cos(lat)cos(dec)cos(lon - subsolarLon):
	// the first term and cos(lat)cos(dec) depend only on the row, cos(hour angle)
	// only on the column, leaving one multiply-add per pixel.
	const rowSinTerm = new Float64Array(tileSize);
	const rowCosTerm = new Float64Array(tileSize);
	for (let i = 0; i < tileSize; i++) {
		const lat = degreesToRadians(tile2lat(y + (i + 0.5) / tileSize, z));
		rowSinTerm[i] = Math.sin(lat) * sinDeclination;
		rowCosTerm[i] = Math.cos(lat) * cosDeclination;
	}
	const colHourAngleCos = new Float64Array(tileSize);
	for (let j = 0; j < tileSize; j++) {
		const lon = tile2lon(x + (j + 0.5) / tileSize, z);
		colHourAngleCos[j] = Math.cos(degreesToRadians(lon - position.subsolarLongitude));
	}

	for (let i = 0; i < tileSize; i++) {
		const sinTerm = rowSinTerm[i];
		const cosTerm = rowCosTerm[i];
		for (let j = 0; j < tileSize; j++) {
			const sinElevation = sinTerm + cosTerm * colHourAngleCos[j];
			if (sinElevation >= 0) continue;

			let t = 1;
			if (sinElevation > sinElevationFull) {
				t = sinElevation / sinElevationFull;
				t = t * t * (3 - 2 * t);
			}

			const ind = 4 * (j + i * tileSize);
			rgba[ind] = r;
			rgba[ind + 1] = g;
			rgba[ind + 2] = b;
			rgba[ind + 3] = maxAlpha * t;
		}
	}
};
