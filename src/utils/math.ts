import type { Domain, Bounds, Center, IndexAndFractions } from '../types';

const PI = Math.PI;

export const degreesToRadians = (degree: number) => {
	return degree * (PI / 180);
};

export const radiansToDegrees = (rad: number) => {
	return rad * (180 / PI);
};

export const tile2lon = (x: number, z: number): number => {
	return (x / Math.pow(2, z)) * 360 - 180;
};

export const tile2lat = (y: number, z: number): number => {
	const n = PI - (2 * PI * y) / Math.pow(2, z);
	return radiansToDegrees(Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
};

export const lon2tile = (lon: number, z: number): number => {
	return Math.pow(2, z) * ((lon + 180) / 360);
};

export const lat2tile = (lat: number, z: number): number => {
	return (
		(Math.pow(2, z) *
			(1 - Math.log(Math.tan(degreesToRadians(lat)) + 1 / Math.cos(degreesToRadians(lat))) / PI)) /
		2
	);
};

// Estimate first derivative (symmetric central)
export const derivative = (fm1: number, fp1: number): number => {
	return (fp1 - fm1) / 2;
};

// Estimate second derivative (Laplacian-like)
export const secondDerivative = (fm1: number, f0: number, fp1: number): number => {
	return fm1 - 2 * f0 + fp1;
};

export const modPositive = (n: number, m: number): number => {
	return ((n % m) + m) % m;
};

export const getCenterFromBounds = (bounds: Bounds): Center => {
	return {
		lng: (bounds[2] - bounds[0]) / 2 + bounds[0],
		lat: (bounds[3] - bounds[1]) / 2 + bounds[1]
	};
};

export const getCenterFromGrid = (grid: Domain['grid']): Center => {
	return {
		lng: grid.lonMin + grid.dx * (grid.nx * 0.5),
		lat: grid.latMin + grid.dy * (grid.ny * 0.5)
	};
};

export const rotatePoint = (cx: number, cy: number, theta: number, x: number, y: number) => {
	const xt = Math.cos(theta) * (x - cx) - Math.sin(theta) * (y - cy) + cx;
	const yt = Math.sin(theta) * (x - cx) + Math.cos(theta) * (y - cy) + cy;

	return [xt, yt];
};

const a1 = 0.99997726;
const a3 = -0.33262347;
const a5 = 0.19354346;
const a7 = -0.11643287;
const a9 = 0.05265332;
const a11 = -0.0117212;

const copysign = (value: number, sign: number) => {
	// If sign is -0, preserve -0
	if (sign === 0 && 1 / sign === -Infinity) {
		return -Math.abs(value);
	}
	return Math.sign(sign) === -1 ? -Math.abs(value) : Math.abs(value);
};

// https://mazzo.li/posts/vectorized-atan2.html
export const fastAtan2 = (y: number, x: number) => {
	const swap = Math.abs(x) < Math.abs(y);
	const selected = swap ? y : x;
	const denominator = selected === 0 ? 0.00000001 : selected;
	const atan_input = (swap ? x : y) / denominator;

	const z_sq = atan_input * atan_input;
	let res = atan_input * (a1 + z_sq * (a3 + z_sq * (a5 + z_sq * (a7 + z_sq * (a9 + z_sq * a11)))));

	if (swap) res = copysign(PI / 2, atan_input) - res;
	if (x < 0.0) res = copysign(PI, y) + res;

	return res;
};

export const hermite = (t: number, p0: number, p1: number, m0: number, m1: number) => {
	const t2 = t * t;
	const t3 = t2 * t;

	const h00 = 2 * t3 - 3 * t2 + 1;
	const h10 = t3 - 2 * t2 + t;
	const h01 = -2 * t3 + 3 * t2;
	const h11 = t3 - t2;

	return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
};

export const getIndexFromLatLong = (
	lat: number,
	lon: number,
	dx: number,
	dy: number,
	nx: number,
	latLonMinMax: [minLat: number, minLon: number, maxLat: number, maxLon: number]
): IndexAndFractions => {
	if (
		lat < latLonMinMax[0] ||
		lat >= latLonMinMax[2] ||
		lon < latLonMinMax[1] ||
		lon >= latLonMinMax[3]
	) {
		return { index: NaN, xFraction: 0, yFraction: 0 };
	} else {
		const x = Math.floor((lon - latLonMinMax[1]) / dx);
		const y = Math.floor((lat - latLonMinMax[0]) / dy);

		const xFraction = ((lon - latLonMinMax[1]) % dx) / dx;
		const yFraction = ((lat - latLonMinMax[0]) % dy) / dy;

		const index = y * nx + x;
		return { index, xFraction, yFraction };
	}
};
