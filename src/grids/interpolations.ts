import { roundWithPrecision } from '../utils/math';

import type { DimensionRange } from '../types';

export const noInterpolation = (values: Float32Array, index: number): number => {
	return Number(values[index]);
};

export const interpolateLinear = (
	values: Float32Array,
	index: number,
	xFraction: number,
	yFraction: number,
	nx: number,
	longitudeWrap: boolean = false
): number => {
	let nextIndex = index + 1;

	if (longitudeWrap) {
		// For global grids, data can wrap to the other side
		nextIndex = nextIndex % (values.length - 1);
		index = index % (values.length - 1);
	} else {
		// Right border
		if (nextIndex % nx === 0) {
			return NaN;
		}
	}

	// Bottom border
	if (index + nx > values.length) {
		return NaN;
	}

	// p0 ---- p1
	// |       |
	// p2 ---- p3
	const p0 = values[index];
	const p1 = values[nextIndex];
	const p2 = values[index + nx];
	const p3 = values[nextIndex + nx];

	const w0 = (1 - xFraction) * (1 - yFraction);
	const w1 = xFraction * (1 - yFraction);
	const w2 = (1 - xFraction) * yFraction;
	const w3 = xFraction * yFraction;

	const n0 = !isFinite(p0);
	const n1 = !isFinite(p1);
	const n2 = !isFinite(p2);
	const n3 = !isFinite(p3);

	// If none are NaN → normal bilinear interpolation
	if (!n0 && !n1 && !n2 && !n3) {
		return roundWithPrecision(p0 * w0 + p1 * w1 + p2 * w2 + p3 * w3);
	}

	// --- EXACTLY ONE POINT MISSING CASES ---
	// ------------------
	// p0 is missing → valid triangle = (p1, p2, p3)
	// ------------------
	if (n0 && !n1 && !n2 && !n3) {
		if (xFraction + yFraction < 1) return NaN; // Not in triangle
		const ws = w1 + w2 + w3;
		return roundWithPrecision((p1 * w1 + p2 * w2 + p3 * w3) / ws);
	}

	// p1 is missing → valid triangle = (p0, p2, p3)
	if (!n0 && n1 && !n2 && !n3) {
		if (1 - xFraction + yFraction < 1) return NaN; // Not in triangle
		const ws = w0 + w2 + w3;
		return roundWithPrecision((p0 * w0 + p2 * w2 + p3 * w3) / ws);
	}

	// p2 is missing → valid triangle = (p0, p1, p3)
	if (!n0 && !n1 && n2 && !n3) {
		if (xFraction + 1 - yFraction < 1) return NaN; // Not in triangle
		const ws = w0 + w1 + w3;
		return roundWithPrecision((p0 * w0 + p1 * w1 + p3 * w3) / ws);
	}

	// p3 is missing → valid triangle = (p0, p1, p2)
	if (!n0 && !n1 && !n2 && n3) {
		if (1 - xFraction + 1 - yFraction < 1) return NaN; // Not in triangle
		const ws = w0 + w1 + w2;
		return roundWithPrecision((p0 * w0 + p1 * w1 + p2 * w2) / ws);
	}

	// More than 1 point missing → no valid triangle
	return NaN;
};

// 1D Cardinal Spline for 4 values
const cardinalSpline = (
	t: number,
	p0: number,
	p1: number,
	p2: number,
	p3: number,
	tension: number
): number => {
	const t2 = t * t;
	const t3 = t2 * t;
	const s = (1 - tension) / 2;

	return (
		s * (-t3 + 2 * t2 - t) * p0 +
		s * (-t3 + t2) * p1 +
		(2 * t3 - 3 * t2 + 1) * p1 +
		s * (t3 - 2 * t2 + t) * p2 +
		(-2 * t3 + 3 * t2) * p2 +
		s * (t3 - t2) * p3
	);
};

export const interpolateCardinal2D = (
	values: Float32Array,
	nx: number,
	index: number,
	xFraction: number,
	yFraction: number,
	tension: number = 0 // range [0,1]. tension = 0 is Catmull-Rom
): number => {
	// Interpolate 4 rows in X
	const r0 = cardinalSpline(
		xFraction,
		Number(values[index + -1 * nx - 1]),
		Number(values[index + -1 * nx + 0]),
		Number(values[index + -1 * nx + 1]),
		Number(values[index + -1 * nx + 2]),
		tension
	);
	const r1 = cardinalSpline(
		xFraction,
		Number(values[index + +0 * nx - 1]),
		Number(values[index + +0 * nx + 0]),
		Number(values[index + +0 * nx + 1]),
		Number(values[index + +0 * nx + 2]),
		tension
	);
	const r2 = cardinalSpline(
		xFraction,
		Number(values[index + +1 * nx - 1]),
		Number(values[index + +1 * nx + 0]),
		Number(values[index + +1 * nx + 1]),
		Number(values[index + +1 * nx + 2]),
		tension
	);
	const r3 = cardinalSpline(
		xFraction,
		Number(values[index + +2 * nx - 1]),
		Number(values[index + +2 * nx + 0]),
		Number(values[index + +2 * nx + 1]),
		Number(values[index + +2 * nx + 2]),
		tension
	);

	// Interpolate in Y
	return cardinalSpline(yFraction, r0, r1, r2, r3, tension);
};

export const interpolate2DHermite = (
	values: Float32Array,
	index: number,
	xFraction: number,
	yFraction: number,
	ranges: DimensionRange[]
) => {
	const nx = ranges[1]['end'] - ranges[1]['start'];

	// tension = 0 is Hermite with Catmull-Rom. Tension = 1 is bilinear interpolation
	// 0.5 is somewhat in the middle
	return interpolateCardinal2D(values, nx, index, xFraction, yFraction, 0.3);

	//return interpolateRBF3x3(values, nx, index, xFraction, yFraction)
	//return interpolateRBF4x4(values, nx, index, xFraction, yFraction)
	//return interpolateSmoothBilinear(values, index, xFraction, yFraction, nx)
	//return interpolateMonotonicHermite(values, nx, index, xFraction, yFraction)
	//return interpolateGaussianBilinear(values, index, xFraction, yFraction, nx)
	//return interpolateLinear(values, index, xFraction, yFraction, nx)
	//return quinticHermite2D(values, nx, index, xFraction, yFraction)

	/*let x = index % nx;
	let y = index / nx;
	let ny = values.length / nx;
	if (x <= 1 || y <= 1 || x >= nx - 3 || y >= ny - 3) {
		return interpolateLinear(values, index, xFraction, yFraction, nx);
	}

	// Interpolate along X for each of the 4 rows
	const interpRow = [];
	for (let j = -1; j < 3; j++) {
		const p0 = values[index + j * nx];
		const p1 = values[index + j * nx + 1];
		const m0 = derivative(values[index + j * nx - 1], values[index + j * nx + 1]);
		const m1 = derivative(values[index + j * nx + 0], values[index + j * nx + 2]);
		interpRow[j + 1] = hermite(xFraction, p0, p1, m0, m1);
	}

	// Interpolate the result along Y
	const p0 = interpRow[1];
	const p1 = interpRow[2];
	const m0 = derivative(interpRow[0], interpRow[2]);
	const m1 = derivative(interpRow[1], interpRow[3]);
	return hermite(yFraction, p0, p1, m0, m1);*/
};

// // 1D Quintic Hermite interpolation
// export const quinticHermite = (
// 	t: number,
// 	f0: number,
// 	f1: number,
// 	m0: number,
// 	m1: number,
// 	c0: number,
// 	c1: number
// ): number => {
// 	const t2 = t * t;
// 	const t3 = t2 * t;
// 	const t4 = t3 * t;
// 	const t5 = t4 * t;

// 	const h0 = 1 - 10 * t3 + 15 * t4 - 6 * t5;
// 	const h1 = t - 6 * t3 + 8 * t4 - 3 * t5;
// 	const h2 = 0.5 * t2 - 1.5 * t3 + 1.5 * t4 - 0.5 * t5;
// 	const h3 = 10 * t3 - 15 * t4 + 6 * t5;
// 	const h4 = -4 * t3 + 7 * t4 - 3 * t5;
// 	const h5 = 0.5 * t3 - t4 + 0.5 * t5;

// 	return h0 * f0 + h1 * m0 + h2 * c0 + h3 * f1 + h4 * m1 + h5 * c1;
// };

// // 2D Quintic Hermite Interpolation on a 6x6 or larger grid
// export const quinticHermite2D = (
// 	values: Float32Array<ArrayBufferLike>,
// 	nx: number,
// 	index: number,
// 	xFraction: number,
// 	yFraction: number
// ): number => {
// 	// Collect interpolated values from 6 rows
// 	const colValues = [];

// 	for (let j = -2; j <= 3; j++) {
// 		const f0 = values[index + j * nx];
// 		const f1 = values[index + j * nx + 1];
// 		const m0 = derivative(values[index + j * nx - 1], values[index + j * nx + 1]);
// 		const m1 = derivative(values[index + j * nx], values[index + j * nx + 2]);
// 		const c0 = secondDerivative(values[index + j * nx - 1], f0, f1);
// 		const c1 = secondDerivative(f0, f1, values[index + j * nx + 2]);

// 		const interpolatedX = quinticHermite(xFraction, f0, f1, m0, m1, c0, c1);
// 		colValues.push(interpolatedX);
// 	}

// 	// Now interpolate in Y
// 	const f0 = colValues[2];
// 	const f1 = colValues[3];
// 	const m0 = derivative(colValues[1], colValues[3]);
// 	const m1 = derivative(colValues[2], colValues[4]);
// 	const c0 = secondDerivative(colValues[0], f0, f1);
// 	const c1 = secondDerivative(f0, f1, colValues[5]);

// 	return quinticHermite(yFraction, f0, f1, m0, m1, c0, c1);
// };

// const interpolateRBF4x4 = (
// 	values: Float32Array | (Float32Array & ArrayBufferLike),
// 	nx: number,
// 	index: number,
// 	xFraction: number,
// 	yFraction: number
// ): number => {
// 	const sigma = 0.65;
// 	const denom = 2 * sigma * sigma;

// 	const ny = values.length / nx;
// 	const x = (index % nx) + xFraction;
// 	const y = Math.floor(index / nx) + yFraction;

// 	const ix = Math.floor(x);
// 	const iy = Math.floor(y);

// 	let sum = 0;
// 	let weightSum = 0;

// 	for (let dy = -1; dy <= 2; dy++) {
// 		for (let dx = -1; dx <= 2; dx++) {
// 			const px = ix + dx;
// 			const py = iy + dy;

// 			if (px < 0 || px >= nx || py < 0 || py >= ny) continue;

// 			const fx = x - px;
// 			const fy = y - py;
// 			const dist2 = fx * fx + fy * fy;
// 			const weight = Math.exp(-dist2 / denom);

// 			const sampleIndex = py * nx + px;
// 			const value = values[sampleIndex];

// 			sum += value * weight;
// 			weightSum += weight;
// 		}
// 	}

// 	return weightSum > 0 ? sum / weightSum : 0;
// };

// const interpolateRBF3x3 = (
// 	values: Float32Array | (Float32Array & ArrayBufferLike),
// 	nx: number,
// 	index: number,
// 	xFraction: number,
// 	yFraction: number
// ): number => {
// 	const sigma = 0.4;
// 	const denom = 2 * sigma * sigma;

// 	const ny = values.length / nx;
// 	const x = (index % nx) + xFraction;
// 	const y = Math.floor(index / nx) + yFraction;

// 	const ix = Math.floor(x);
// 	const iy = Math.floor(y);

// 	let sum = 0;
// 	let weightSum = 0;

// 	for (let dy = -1; dy <= 1; dy++) {
// 		for (let dx = -1; dx <= 1; dx++) {
// 			const px = ix + dx;
// 			const py = iy + dy;

// 			if (px < 0 || px >= nx || py < 0 || py >= ny) continue;

// 			const fx = x - px;
// 			const fy = y - py;
// 			const dist2 = fx * fx + fy * fy;
// 			const weight = Math.exp(-dist2 / denom);

// 			const sampleIndex = py * nx + px;
// 			const value = values[sampleIndex];

// 			sum += value * weight;
// 			weightSum += weight;
// 		}
// 	}

// 	return weightSum > 0 ? sum / weightSum : 0;
// };
