import { modPositive, roundWithPrecision } from '../utils/math';

import { GridInterface, GridPoint } from './interface';
import { catmullRom1D, monotoneHermite } from './interpolations';

import { Bounds, DimensionRange, GaussianGridData, InterpolationMethod } from '../types';

/**
 * Implementation of a Gaussian grid projection for mapping, specifically the O1280 version used by ECMWF IFS
 */
export class GaussianGrid implements GridInterface {
	// should always be 1 for gaussian grids!
	private readonly ny: number;
	// nx contains all grid points in a single dimension
	private readonly nx: number;
	// nxStart can be used to read partial data
	// it basically shifts the indices when accessing the data
	private readonly nxStart: number;

	private readonly latitudeLines: number;

	constructor(data: GaussianGridData, ranges: DimensionRange[] | null = null) {
		this.latitudeLines = data.gaussianGridLatitudeLines;

		if (!ranges) {
			ranges = [
				{ start: 0, end: data.ny },
				{ start: 0, end: data.nx }
			];
		}
		this.nx = data.nx;
		this.nxStart = ranges[1].start;
		this.ny = data.ny;
	}

	getBounds(): Bounds {
		// FIXME: global for now
		return [-180, -90, 180, 90];
	}

	getCenter(): { lng: number; lat: number } {
		// FIXME: Center hardcoded for now
		return { lng: 0, lat: 0 };
	}

	getCoveringRanges(south: number, _west: number, north: number, _east: number): DimensionRange[] {
		const northY = this.yLower(north);
		const southY = this.yLower(south) + 2; // This makes sure we cover at least two latitude rows, which is needed for very high zoom levels

		// We need to treat border points specially, because the yLower function is not well behaved at the poles
		let southX: number;
		const southIntegral = this.integral(southY);
		if (southY > this.latitudeLines * 2 || southIntegral >= this.nx) {
			southX = this.nx;
		} else {
			southX = this.integral(southY) % this.nx;
		}

		let northX: number;
		const moduloNorth = (this.latitudeLines * 2) % northY;
		if (moduloNorth < 2) {
			northX = 0;
		} else {
			northX = this.integral(northY) % this.nx;
		}

		return [
			{ start: 0, end: this.ny },
			{ start: northX, end: southX }
		];
	}

	/**
	 * Number of points in the grid
	 */
	private get count(): number {
		return 4 * this.latitudeLines * (this.latitudeLines + 9); // 6599680
	}

	/**
	 * Get the number of points in a specific latitude line
	 * @param y - The latitude line index
	 */
	nxOf(y: number): number {
		return y < this.latitudeLines ? 20 + y * 4 : (2 * this.latitudeLines - y - 1) * 4 + 20;
	}

	private integral(y: number): number {
		return y < this.latitudeLines
			? 2 * y * y + 18 * y - this.nxStart
			: this.count -
					(2 * (2 * this.latitudeLines - y) * (2 * this.latitudeLines - y) +
						18 * (2 * this.latitudeLines - y)) -
					this.nxStart;
	}

	/**
	 * Get the latitude and longitude coordinates for a grid point
	 */
	/*getCoordinates(gridpoint: number): { latitude: number; longitude: number } {
		const { y: y, x: x, nx: nx } = this.getPos(gridpoint);

		const dx = 360 / nx;
		const dy = 180 / (2 * this.latitudeLines + 0.5);

		const lon = x * dx;
		const adjustedLon = lon >= 180 ? lon - 360 : lon;

		return {
			latitude: (this.latitudeLines - y - 1) * dy + dy / 2,
			longitude: adjustedLon
		};
	}*/

	/**
	 * Find the grid point index for given latitude and longitude
	 */
	/*findPoint(lat: number, lon: number): number {
		const dy = 180 / (2 * this.latitudeLines + 0.5);
		const y =
			(Math.round(this.latitudeLines - 1 - (lat - dy / 2) / dy) + 2 * this.latitudeLines) %
			(2 * this.latitudeLines);

		const nx = this.nxOf(y);
		const dx = 360 / nx;

		const x = (Math.round(lon / dx) + nx) % nx;
		return this.integral(y) + x;
	}*/

	/*getPos(gridpoint: number): { y: number; x: number; nx: number } {
		const y =
			gridpoint < this.count / 2
				? Math.floor((Math.sqrt(2 * gridpoint + 81) - 9) / 2)
				: 2 * this.latitudeLines -
					1 -
					Math.floor((Math.sqrt(2 * (this.count - gridpoint - 1) + 81) - 9) / 2);

		const integral = this.integral(y);
		const x = gridpoint - integral;
		const nx = this.nxOf(y);

		return { y, x, nx };
	}*/

	getInterpolatedValue(
		values: Float32Array,
		lat: number,
		lon: number,
		method: InterpolationMethod,
		_smoothFootprint?: number
	): number {
		switch (method) {
			case 'nearest':
				return this.getNearestNeighborValue(values, lat, lon);
			case 'cubic':
				return this.getCubicValue(values, lat, lon, false);
			case 'monotone':
				return this.getCubicValue(values, lat, lon, true);
			// 'smooth' needs a summed-area table, which assumes a rectangular grid;
			// a reduced Gaussian grid is a ragged 1D array, so it has no cheap
			// equivalent. Fall back to bilinear for 'smooth' (and 'linear').
			case 'smooth':
			case 'linear':
			default:
				return this.getLinearInterpolatedValue(values, lat, lon);
		}
	}

	// Separable bicubic on the reduced Gaussian grid. Because every latitude row
	// has its own number of longitude points (nxOf), the 4x4 stencil used on a
	// regular grid does not line up across rows. Instead we interpolate each of
	// the 4 surrounding latitude rows independently in longitude (a 4-point stencil
	// that wraps around the row), then combine those 4 row-results in latitude.
	// `monotone` selects shape-preserving PCHIP slopes; otherwise Catmull-Rom with
	// the same inner-cell overshoot clamp the regular grid uses. The 4-row latitude
	// stencil is unavailable near the poles and a missing (NaN) sample would smear,
	// so both cases fall back to NaN-aware bilinear.
	private getCubicValue(values: Float32Array, lat: number, lon: number, monotone: boolean): number {
		const latitudeLines = this.latitudeLines;
		const rows = 2 * latitudeLines;
		const dy = 180 / (rows + 0.5);
		const yReal = latitudeLines - 1 - (lat - dy / 2) / dy;
		const yLower = Math.floor(yReal);
		const yFraction = yReal - yLower;

		// Need latitude rows yLower-1 .. yLower+2; latitude does not wrap, so near
		// the poles fall back to bilinear (which clamps to the two edge rows).
		if (yLower < 1 || yLower >= rows - 2) {
			return this.getLinearInterpolatedValue(values, lat, lon);
		}

		const r0 = this.interpRowLon(values, yLower - 1, lon, monotone);
		const r1 = this.interpRowLon(values, yLower, lon, monotone);
		const r2 = this.interpRowLon(values, yLower + 1, lon, monotone);
		const r3 = this.interpRowLon(values, yLower + 2, lon, monotone);
		if (!isFinite(r0.v) || !isFinite(r1.v) || !isFinite(r2.v) || !isFinite(r3.v)) {
			return this.getLinearInterpolatedValue(values, lat, lon);
		}

		if (monotone) {
			return roundWithPrecision(monotoneHermite(yFraction, r0.v, r1.v, r2.v, r3.v));
		}

		// Catmull-Rom can ring past the data; clamp to the inner cell (the two
		// latitude rows that bracket the sample, and their bracketing longitude
		// samples) exactly like interpolateCubic on the regular grid.
		const result = catmullRom1D(yFraction, r0.v, r1.v, r2.v, r3.v);
		const lo = Math.min(r1.p0, r1.p1, r2.p0, r2.p1);
		const hi = Math.max(r1.p0, r1.p1, r2.p0, r2.p1);
		return roundWithPrecision(Math.min(Math.max(result, lo), hi));
	}

	// Interpolate `lon` within a single latitude row using a wrapping 4-point
	// cubic stencil. Returns the interpolated value `v` plus the two raw samples
	// (`p0`, `p1`) that bracket lon, which the caller uses for overshoot clamping.
	// `v` is NaN if any of the 4 stencil samples is missing.
	private interpRowLon(
		values: Float32Array,
		y: number,
		lon: number,
		monotone: boolean
	): { v: number; p0: number; p1: number } {
		const nx = this.nxOf(y);
		const dx = 360 / nx;
		const x0 = modPositive(Math.floor(lon / dx), nx);
		const t = modPositive(lon / dx, 1);
		const base = this.integral(y);

		const pm1 = values[base + modPositive(x0 - 1, nx)];
		const p0 = values[base + x0];
		const p1 = values[base + ((x0 + 1) % nx)];
		const p2 = values[base + ((x0 + 2) % nx)];

		if (!isFinite(pm1) || !isFinite(p0) || !isFinite(p1) || !isFinite(p2)) {
			return { v: NaN, p0, p1 };
		}

		const v = monotone ? monotoneHermite(t, pm1, p0, p1, p2) : catmullRom1D(t, pm1, p0, p1, p2);
		return { v, p0, p1 };
	}

	/// Values is the 1D array of all HRES values (6 million something values)
	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number {
		const latitudeLines = this.latitudeLines;
		const dy = 180 / (2 * latitudeLines + 0.5);
		const yLower = modPositive(
			Math.floor(latitudeLines - 1 - (lat - dy / 2) / dy),
			2 * latitudeLines
		);
		const yFraction = modPositive(latitudeLines - 1 - (lat - dy / 2) / dy, 1);
		const yUpper = yLower + 1;
		const nxLower = this.nxOf(yLower);
		const nxUpper = this.nxOf(yUpper);
		const dxLower = 360 / nxLower;
		const dxUpper = 360 / nxUpper;
		const xLower0 = modPositive(Math.floor(lon / dxLower), nxLower);
		const xUpper0 = modPositive(Math.floor(lon / dxUpper), nxUpper);
		const integralLower = this.integral(yLower);
		const integralUpper = this.integral(yUpper);
		const xFractionLower = modPositive(lon / dxLower, 1);
		const xFractionUpper = modPositive(lon / dxUpper, 1);

		//    yUpper    p2 ---- p3
		//             /       /
		//            /       /
		//    yLower  p0 ---- p1
		const p0 = values[integralLower + xLower0];
		const p1 = values[integralLower + ((xLower0 + 1) % nxLower)];
		const p2 = values[integralUpper + xUpper0];
		const p3 = values[integralUpper + ((xUpper0 + 1) % nxUpper)];

		const w0 = (1 - xFractionLower) * (1 - yFraction);
		const w1 = xFractionLower * (1 - yFraction);
		const w2 = (1 - xFractionUpper) * yFraction;
		const w3 = xFractionUpper * yFraction;

		const n0 = !isFinite(p0);
		const n1 = !isFinite(p1);
		const n2 = !isFinite(p2);
		const n3 = !isFinite(p3);

		// If none are NaN → normal bilinear interpolation
		if (!n0 && !n1 && !n2 && !n3) {
			return roundWithPrecision(p0 * w0 + p1 * w1 + p2 * w2 + p3 * w3);
		}

		const xFraction = (1 - yFraction) * xFractionLower + yFraction * xFractionUpper;

		// --- EXACTLY ONE POINT MISSING CASES ---
		// ------------------
		// p0 is missing → valid triangle = (p1, p2, p3)
		// ------------------
		if (n0 && !n1 && !n2 && !n3) {
			if (xFractionLower < xFractionUpper || xFraction + yFraction < 1) return NaN; // Not in triangle
			const ws = w1 + w2 + w3;
			return roundWithPrecision((p1 * w1 + p2 * w2 + p3 * w3) / ws);
		}

		// p1 is missing → valid triangle = (p0, p2, p3)
		if (!n0 && n1 && !n2 && !n3) {
			if (xFractionLower > xFractionUpper || xFraction + 1 - yFraction > 1) return NaN; // Not in triangle
			const ws = w0 + w2 + w3;
			return roundWithPrecision((p0 * w0 + p2 * w2 + p3 * w3) / ws);
		}

		// p2 is missing → valid triangle = (p0, p1, p3)
		if (!n0 && !n1 && n2 && !n3) {
			if (xFractionLower > xFractionUpper || xFraction + 1 - yFraction < 1) return NaN; // Not in triangle
			const ws = w0 + w1 + w3;
			return roundWithPrecision((p0 * w0 + p1 * w1 + p3 * w3) / ws);
		}

		// p3 is missing → valid triangle = (p0, p1, p2)
		if (!n0 && !n1 && !n2 && n3) {
			if (xFractionLower < xFractionUpper || xFraction + yFraction > 1) return NaN; // Not in triangle
			const ws = w0 + w1 + w2;
			return roundWithPrecision((p0 * w0 + p1 * w1 + p2 * w2) / ws);
		}

		// More than 1 point missing → no valid triangle
		return NaN;
	}

	/// Values is the 1D array of all HRES values (6 million something values)
	getNearestNeighborValue(values: Float32Array, lat: number, lon: number): number {
		const latitudeLines = this.latitudeLines;
		const dy = 180 / (2 * latitudeLines + 0.5);
		const y = modPositive(Math.round(latitudeLines - 1 - (lat - dy / 2) / dy), 2 * latitudeLines);
		const nx = this.nxOf(y);
		const dx = 360 / nx;
		const x = modPositive(Math.floor(lon / dx), nx);
		const integral = this.integral(y);
		const index = integral + x;
		return values[index];
	}

	// FIXME: This function might not behave well at the poles!
	private yLower(lat: number) {
		const latitudeLines = this.latitudeLines;
		const dy = 180 / (2 * latitudeLines + 0.5);
		return modPositive(Math.floor(latitudeLines - 1 - (lat - dy / 2) / dy), 2 * latitudeLines);
	}

	forEachPoint(callback: (point: GridPoint) => void | false, bounds?: Bounds): void {
		const dy = 180 / (2 * this.latitudeLines + 0.5);
		for (let y = 0; y < 2 * this.latitudeLines; y++) {
			const lat = (this.latitudeLines - y - 1) * dy + dy / 2;
			if (bounds && (lat < bounds[1] || lat > bounds[3])) continue;
			const nx = this.nxOf(y);
			const dx = 360 / nx;
			const integralY = this.integral(y);
			for (let x = 0; x < nx; x++) {
				const lon = x * dx;
				const adjustedLon = lon >= 180 ? lon - 360 : lon;
				if (bounds && (adjustedLon < bounds[0] || adjustedLon > bounds[2])) continue;
				const index = integralY + x;
				const result = callback({ index, lat, lon: adjustedLon });
				if (result === false) return;
			}
		}
	}
}
