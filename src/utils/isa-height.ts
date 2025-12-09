// ISA / barometric constants
/** reference pressure in hPa */
const P_0 = 1013.25;
/** sea-level standard temperature (K) */
const T_0 = 288.15;
/** temperature lapse rate (K/m) */
const LAPSE = 0.0065;
/** specific gas constant for dry air (J/(kg·K)) */
const GAS_CONSTANT = 287.05;
/** gravity (m/s^2) */
const G_0 = 9.80665;

/* Tropopause / lower stratosphere constants (ISA standard) */
/** pressure at tropopause in hPa */
const P_TROPOPAUSE = 226.32;
/** height of tropopause in meters */
const H_TROPOPAUSE = 11000;
/** temperature in lower stratosphere in Kelvin */
const T_TROPOPAUSE = 216.65;

/** Converts pressure in hPa to ISA (International Standard Atmosphere) height in meters */
export const pressureHpaToIsaHeight = (hpa: number): number => {
	if (!isFinite(hpa) || hpa <= 0) return NaN;

	// Use troposphere formula for pressures >= tropopause pressure; otherwise use isothermal stratosphere formula.
	return hpa >= P_TROPOPAUSE
		? troposphereHeightFromPressure(hpa)
		: stratosphereHeightFromPressure(hpa);
};

const troposphereHeightFromPressure = (hpa: number): number => {
	const r = hpa / P_0;
	const exponent = (GAS_CONSTANT * LAPSE) / G_0; // dimensionless (~0.1903)
	// H = (T0 / L) * (1 - r^exponent)
	return (T_0 / LAPSE) * (1 - Math.pow(r, exponent));
};

const stratosphereHeightFromPressure = (hpa: number): number => {
	// H = H_tropopause + (R * T_tropopause / g0) * ln(P_tropopause / P)
	return H_TROPOPAUSE + ((GAS_CONSTANT * T_TROPOPAUSE) / G_0) * Math.log(P_TROPOPAUSE / hpa);
};
