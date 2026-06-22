import { roundWithPrecision } from '../utils/math';

// Summed-area table (integral image) based area averaging.
//
// Bilinear/cubic interpolation reconstruct a value at a single point. When the
// data carries structure finer than the screen footprint — e.g. the
// constant-value plateaus that nearest-neighbour regridding leaves on a regular
// lat/lon grid towards the poles — point sampling (in any interpolation space)
// cannot remove it. Averaging the grid over a footprint that is isotropic in
// physical space does: near the poles that footprint is wide in longitude
// (∝ 1/cos φ) and so spans the plateau.
//
// A summed-area table makes the box average O(1) per pixel after an O(nx·ny)
// build, so the per-tile cost is independent of the footprint size.

export interface SummedAreaTable {
	nx: number;
	ny: number;
	// Integral images of dimension (nx+1) x (ny+1). `sum` accumulates valid
	// values, `count` accumulates the number of valid (non-NaN) samples so that
	// masked cells are excluded from the average.
	sum: Float64Array;
	count: Float32Array;
}

export const buildSummedAreaTable = (
	values: Float32Array,
	nx: number,
	ny: number
): SummedAreaTable => {
	const w = nx + 1;
	const sum = new Float64Array(w * (ny + 1));
	const count = new Float32Array(w * (ny + 1));

	for (let j = 0; j < ny; j++) {
		const rowAbove = j * w;
		const row = (j + 1) * w;
		for (let i = 0; i < nx; i++) {
			const v = values[j * nx + i];
			const valid = isFinite(v);
			const a = sum[rowAbove + i];
			const b = sum[rowAbove + (i + 1)];
			const c = sum[row + i];
			sum[row + (i + 1)] = (valid ? v : 0) + b + c - a;

			const ca = count[rowAbove + i];
			const cb = count[rowAbove + (i + 1)];
			const cc = count[row + i];
			count[row + (i + 1)] = (valid ? 1 : 0) + cb + cc - ca;
		}
	}

	return { nx, ny, sum, count };
};

// Bilinearly sample an integral image at a fractional corner (x in [0, nx],
// y in [0, ny]) so that the averaging box edges move continuously instead of
// snapping to whole cells (which would re-introduce faint banding).
const sampleIntegral = (arr: Float64Array | Float32Array, w: number, x: number, y: number) => {
	const h = arr.length / w; // (ny + 1)
	const x0 = Math.min(Math.max(Math.floor(x), 0), w - 2);
	const y0 = Math.min(Math.max(Math.floor(y), 0), h - 2);
	const fx = x - x0;
	const fy = y - y0;
	const i00 = y0 * w + x0;
	const a = arr[i00];
	const b = arr[i00 + 1];
	const c = arr[i00 + w];
	const d = arr[i00 + w + 1];
	return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
};

// Raw {sum, count} over the box [x0, x1] x [y0, y1] (clamped to the grid).
const boxSums = (
	sat: SummedAreaTable,
	x0: number,
	y0: number,
	x1: number,
	y1: number
): { sum: number; count: number } => {
	const w = sat.nx + 1;
	x0 = Math.min(Math.max(x0, 0), sat.nx);
	x1 = Math.min(Math.max(x1, 0), sat.nx);
	y0 = Math.min(Math.max(y0, 0), sat.ny);
	y1 = Math.min(Math.max(y1, 0), sat.ny);

	const sum =
		sampleIntegral(sat.sum, w, x1, y1) -
		sampleIntegral(sat.sum, w, x0, y1) -
		sampleIntegral(sat.sum, w, x1, y0) +
		sampleIntegral(sat.sum, w, x0, y0);
	const count =
		sampleIntegral(sat.count, w, x1, y1) -
		sampleIntegral(sat.count, w, x0, y1) -
		sampleIntegral(sat.count, w, x1, y0) +
		sampleIntegral(sat.count, w, x0, y0);
	return { sum, count };
};

// Average over the box [x0, x1] x [y0, y1] given in fractional cell coordinates.
// When `wrapX` is set, a box that runs off the left/right edge wraps around in
// longitude (global grids) so the average is continuous across the antimeridian
// instead of being clamped to one side of the seam. Returns NaN when the box
// contains no valid samples.
export const areaAverage = (
	sat: SummedAreaTable,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	wrapX: boolean = false
): number => {
	let s: number;
	let c: number;

	if (wrapX && (x0 < 0 || x1 > sat.nx)) {
		const a = boxSums(sat, Math.max(x0, 0), y0, Math.min(x1, sat.nx), y1);
		// the part that ran off one edge re-enters on the other
		const b =
			x0 < 0 ? boxSums(sat, sat.nx + x0, y0, sat.nx, y1) : boxSums(sat, 0, y0, x1 - sat.nx, y1);
		s = a.sum + b.sum;
		c = a.count + b.count;
	} else {
		const r = boxSums(sat, x0, y0, x1, y1);
		s = r.sum;
		c = r.count;
	}

	// Round to the same precision as the bilinear/bicubic samplers. The SAT
	// differences of large integral values leave ~1e-9 of float noise, which —
	// on a flat plateau whose value coincides with a colour breakpoint — would
	// otherwise dither the colour bucket and speckle the band edge.
	return c > 1e-6 ? roundWithPrecision(s / c) : NaN;
};
