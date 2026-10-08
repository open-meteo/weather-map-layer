/**
 * Per-cell formulas behind the humidity-derived default derivation rules,
 * ported from the Open-Meteo API (`Meteorology.swift`) so a map shows the same
 * numbers as the forecast endpoint. Temperatures in °C, humidity in %, wind in
 * m/s, radiation in W/m².
 */

/** Dew point from air temperature and relative humidity, Magnus formula. */
export const dewPoint = (temperature: number, relativeHumidity: number): number => {
	const beta = 17.625;
	const lambda = 243.04;
	const gamma = Math.log(relativeHumidity / 100) + (beta * temperature) / (lambda + temperature);
	return (lambda * gamma) / (beta - gamma);
};

/**
 * Relative humidity from air temperature and dew point, the Magnus formula
 * inverted, clamped to 0–100 %.
 */
export const relativeHumidity = (temperature: number, dewPoint: number): number => {
	const beta = 17.625;
	const lambda = 243.04;
	const humidity =
		(100 * Math.exp((beta * dewPoint) / (lambda + dewPoint))) /
		Math.exp((beta * temperature) / (lambda + temperature));
	return Math.max(Math.min(humidity, 100), 0);
};

/**
 * Vapour pressure deficit in kPa: saturation vapour pressure at the air
 * temperature minus the actual vapour pressure at the dew point (Tetens).
 * Clamped at zero, since a dew point above the air temperature is possible in
 * rounded model output.
 */
export const vapourPressureDeficit = (temperature: number, dewPoint: number): number => {
	const saturation = 0.6108 * Math.exp((17.27 * temperature) / (temperature + 237.3));
	const actual = 0.6108 * Math.exp((17.27 * dewPoint) / (dewPoint + 237.3));
	return Math.max(saturation - actual, 0);
};

/**
 * Wet-bulb temperature from air temperature and relative humidity (Stull
 * 2011), capped at the air temperature where the fit overshoots near
 * saturation.
 */
export const wetBulbTemperature = (temperature: number, relativeHumidity: number): number => {
	const t = temperature;
	const rh = relativeHumidity;
	const wetBulb =
		t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
		Math.atan(t + rh) -
		Math.atan(rh - 1.676331) +
		0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
		4.686035;
	return Math.min(wetBulb, t);
};

/**
 * Apparent temperature (Steadman): humidity warms, wind cools, and radiation
 * above 550 W/m² warms. The 10 m wind speed is scaled to the 2 m level a body
 * experiences.
 */
export const apparentTemperature = (
	temperature: number,
	relativeHumidity: number,
	windSpeed10m: number,
	shortwaveRadiation: number
): number => {
	const windSpeed2m = windSpeed10m * 0.75;
	// Vapour pressure in hPa
	const vapourPressure =
		(relativeHumidity / 100) * 6.105 * Math.exp((17.27 * temperature) / (237.7 + temperature));
	// Radiation absorbed by the body
	const absorbed = Math.max(0, 0.1 * (shortwaveRadiation - 550));
	return (
		temperature +
		0.348 * vapourPressure -
		0.7 * windSpeed2m +
		0.7 * (absorbed / (windSpeed2m + 10)) -
		4.25
	);
};
