import { roundWithPrecision } from '../utils/math';

export const interpolateLinear = (
	values: Float32Array,
	x: number,
	y: number,
	xFraction: number,
	yFraction: number,
	nx: number,
	longitudeWrap: boolean = false
): number => {
	const index = y * nx + x;

	let nextIndex: number;
	if (longitudeWrap) {
		// For global grids, data can wrap to the other side
		nextIndex = y * nx + ((x + 1) % nx);
	} else {
		nextIndex = index + 1;
		// Right border
		if (nextIndex % nx === 0) {
			return NaN;
		}
	}

	// Bottom border
	if (index + nx > values.length) {
		return NaN;
	}

	// p2 ---- p3
	// |       |
	// p0 ---- p1
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

export const interpolateNearest = (
	values: Float32Array,
	x: number,
	y: number,
	xFraction: number,
	yFraction: number,
	nx: number,
	ny: number,
	longitudeWrap: boolean = false
): number => {
	let xi = xFraction >= 0.5 ? x + 1 : x;
	const yi = yFraction >= 0.5 ? Math.min(y + 1, ny - 1) : y;
	if (xi >= nx) xi = longitudeWrap ? xi % nx : nx - 1;
	return values[yi * nx + xi];
};

// Separable bicubic (Catmull-Rom) interpolation.
// Unlike bilinear (which is only C0 — its gradient jumps at every grid line)
// this is C1-continuous, so the faceted "staircase" kinks that become very
// visible towards the poles on regular lat/lon grids disappear.
// The 4x4 stencil is unavailable at the grid border, and cubic would smear
// values across masked (NaN) cells, so in those cases we fall back to the
// NaN-aware bilinear interpolation.
export const interpolateCubic = (
	values: Float32Array,
	x: number,
	y: number,
	xFraction: number,
	yFraction: number,
	nx: number,
	ny: number,
	longitudeWrap: boolean = false
): number => {
	// Rows y-1 .. y+2 must all exist
	if (y < 1 || y >= ny - 2) {
		return interpolateLinear(values, x, y, xFraction, yFraction, nx, longitudeWrap);
	}

	// Column indices, wrapping in longitude for global grids
	let c0: number, c1: number, c2: number, c3: number;
	if (longitudeWrap) {
		c0 = (x - 1 + nx) % nx;
		c1 = x % nx;
		c2 = (x + 1) % nx;
		c3 = (x + 2) % nx;
	} else if (x < 1 || x >= nx - 2) {
		return interpolateLinear(values, x, y, xFraction, yFraction, nx, longitudeWrap);
	} else {
		c0 = x - 1;
		c1 = x;
		c2 = x + 1;
		c3 = x + 2;
	}

	// Catmull-Rom (tension 0) basis weights for xFraction. All 4 rows share the
	// same xFraction, so compute the weights once and reuse them as a dot product
	// instead of re-evaluating the spline (t^2/t^3 + 6 mults) per row.
	const tx2 = xFraction * xFraction;
	const tx3 = tx2 * xFraction;
	const wx0 = 0.5 * (-tx3 + 2 * tx2 - xFraction);
	const wx1 = 0.5 * (3 * tx3 - 5 * tx2 + 2);
	const wx2 = 0.5 * (-3 * tx3 + 4 * tx2 + xFraction);
	const wx3 = 0.5 * (tx3 - tx2);

	// Interpolate each of the 4 rows in X. Track the min/max of the inner 2x2
	// cell (rows y and y+1, columns c1/c2) to clamp overshoot: Catmull-Rom can
	// ring past the local data range, which near a colour breakpoint produces
	// spurious extra bands / contour wiggles.
	// Any missing sample -> fall back to NaN-aware bilinear.
	const b0 = (y - 1) * nx;
	let p0 = values[b0 + c0];
	let p1 = values[b0 + c1];
	let p2 = values[b0 + c2];
	let p3 = values[b0 + c3];
	if (!isFinite(p0) || !isFinite(p1) || !isFinite(p2) || !isFinite(p3))
		return interpolateLinear(values, x, y, xFraction, yFraction, nx, longitudeWrap);
	const r0 = wx0 * p0 + wx1 * p1 + wx2 * p2 + wx3 * p3;

	const b1 = y * nx;
	p0 = values[b1 + c0];
	p1 = values[b1 + c1];
	p2 = values[b1 + c2];
	p3 = values[b1 + c3];
	if (!isFinite(p0) || !isFinite(p1) || !isFinite(p2) || !isFinite(p3))
		return interpolateLinear(values, x, y, xFraction, yFraction, nx, longitudeWrap);
	const r1 = wx0 * p0 + wx1 * p1 + wx2 * p2 + wx3 * p3;
	let lo = Math.min(p1, p2);
	let hi = Math.max(p1, p2);

	const b2 = (y + 1) * nx;
	p0 = values[b2 + c0];
	p1 = values[b2 + c1];
	p2 = values[b2 + c2];
	p3 = values[b2 + c3];
	if (!isFinite(p0) || !isFinite(p1) || !isFinite(p2) || !isFinite(p3))
		return interpolateLinear(values, x, y, xFraction, yFraction, nx, longitudeWrap);
	const r2 = wx0 * p0 + wx1 * p1 + wx2 * p2 + wx3 * p3;
	lo = Math.min(lo, p1, p2);
	hi = Math.max(hi, p1, p2);

	const b3 = (y + 2) * nx;
	p0 = values[b3 + c0];
	p1 = values[b3 + c1];
	p2 = values[b3 + c2];
	p3 = values[b3 + c3];
	if (!isFinite(p0) || !isFinite(p1) || !isFinite(p2) || !isFinite(p3))
		return interpolateLinear(values, x, y, xFraction, yFraction, nx, longitudeWrap);
	const r3 = wx0 * p0 + wx1 * p1 + wx2 * p2 + wx3 * p3;

	// Interpolate the 4 row-results in Y, then clamp to the cell range
	const ty2 = yFraction * yFraction;
	const ty3 = ty2 * yFraction;
	const result =
		0.5 * (-ty3 + 2 * ty2 - yFraction) * r0 +
		0.5 * (3 * ty3 - 5 * ty2 + 2) * r1 +
		0.5 * (-3 * ty3 + 4 * ty2 + yFraction) * r2 +
		0.5 * (ty3 - ty2) * r3;
	return roundWithPrecision(Math.min(Math.max(result, lo), hi));
};

// 1D monotone cubic Hermite (Fritsch–Carlson / PCHIP) over the middle interval
// [p1, p2] of a uniform 4-point stencil, evaluated at t ∈ [0,1]. The endpoint
// tangents are the harmonic mean of the neighbouring secant slopes and are
// zeroed at a local extremum (sign change or flat run). This makes the segment
// shape-preserving: the result stays within [min(p1,p2), max(p1,p2)] and cannot
// ring past a local extremum.
const monotoneHermite = (t: number, p0: number, p1: number, p2: number, p3: number): number => {
	const d0 = p1 - p0; // left secant
	const d1 = p2 - p1; // middle secant (the interval, h = 1)
	const d2 = p3 - p2; // right secant

	const m1 = d0 * d1 <= 0 ? 0 : (2 * d0 * d1) / (d0 + d1);
	const m2 = d1 * d2 <= 0 ? 0 : (2 * d1 * d2) / (d1 + d2);

	const t2 = t * t;
	const t3 = t2 * t;
	return (
		(2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2 + (t3 - t2) * m2
	);
};

// Separable monotone bicubic (Fritsch–Carlson / PCHIP) interpolation. Like the
// Catmull-Rom interpolateCubic it is C1-continuous and removes the bilinear
// "staircase" faceting, but because its slopes are limited it is shape-preserving:
// it never overshoots the surrounding samples, so it cannot produce the spurious
// extra colour bands / contour wiggles that ringing causes near a breakpoint —
// and it needs no hard min/max clamp to achieve that. The 4x4 stencil is
// unavailable at the grid border and cubic would smear values across masked (NaN)
// cells, so in those cases it falls back to NaN-aware bilinear, exactly like cubic.
export const interpolateMonotone = (
	values: Float32Array,
	x: number,
	y: number,
	xFraction: number,
	yFraction: number,
	nx: number,
	ny: number,
	longitudeWrap: boolean = false
): number => {
	// Rows y-1 .. y+2 must all exist
	if (y < 1 || y >= ny - 2) {
		return interpolateLinear(values, x, y, xFraction, yFraction, nx, longitudeWrap);
	}

	// Column indices, wrapping in longitude for global grids
	let c0: number, c1: number, c2: number, c3: number;
	if (longitudeWrap) {
		c0 = (x - 1 + nx) % nx;
		c1 = x % nx;
		c2 = (x + 1) % nx;
		c3 = (x + 2) % nx;
	} else if (x < 1 || x >= nx - 2) {
		return interpolateLinear(values, x, y, xFraction, yFraction, nx, longitudeWrap);
	} else {
		c0 = x - 1;
		c1 = x;
		c2 = x + 1;
		c3 = x + 2;
	}

	// Interpolate each of the 4 rows in X with the monotone spline. Any missing
	// sample -> fall back to NaN-aware bilinear. Unlike Catmull-Rom the X weights
	// depend on the row's own values (slope limiting), so they can't be shared.
	const b0 = (y - 1) * nx;
	let p0 = values[b0 + c0];
	let p1 = values[b0 + c1];
	let p2 = values[b0 + c2];
	let p3 = values[b0 + c3];
	if (!isFinite(p0) || !isFinite(p1) || !isFinite(p2) || !isFinite(p3))
		return interpolateLinear(values, x, y, xFraction, yFraction, nx, longitudeWrap);
	const r0 = monotoneHermite(xFraction, p0, p1, p2, p3);

	const b1 = y * nx;
	p0 = values[b1 + c0];
	p1 = values[b1 + c1];
	p2 = values[b1 + c2];
	p3 = values[b1 + c3];
	if (!isFinite(p0) || !isFinite(p1) || !isFinite(p2) || !isFinite(p3))
		return interpolateLinear(values, x, y, xFraction, yFraction, nx, longitudeWrap);
	const r1 = monotoneHermite(xFraction, p0, p1, p2, p3);

	const b2 = (y + 1) * nx;
	p0 = values[b2 + c0];
	p1 = values[b2 + c1];
	p2 = values[b2 + c2];
	p3 = values[b2 + c3];
	if (!isFinite(p0) || !isFinite(p1) || !isFinite(p2) || !isFinite(p3))
		return interpolateLinear(values, x, y, xFraction, yFraction, nx, longitudeWrap);
	const r2 = monotoneHermite(xFraction, p0, p1, p2, p3);

	const b3 = (y + 2) * nx;
	p0 = values[b3 + c0];
	p1 = values[b3 + c1];
	p2 = values[b3 + c2];
	p3 = values[b3 + c3];
	if (!isFinite(p0) || !isFinite(p1) || !isFinite(p2) || !isFinite(p3))
		return interpolateLinear(values, x, y, xFraction, yFraction, nx, longitudeWrap);
	const r3 = monotoneHermite(xFraction, p0, p1, p2, p3);

	// Interpolate the 4 row-results in Y with the same monotone spline.
	return roundWithPrecision(monotoneHermite(yFraction, r0, r1, r2, r3));
};
