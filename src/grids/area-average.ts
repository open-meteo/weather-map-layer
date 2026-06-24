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

// Bilinearly sample an integral image at a precomputed fractional corner. The
// integer cell (ix, iy) and the fractions (fx, fy) are shared by the `sum` and
// `count` arrays and across the four box corners, so they are resolved once in
// boxSums (Math.floor/clamp are the bulk of the per-pixel cost) and passed in.
const sampleCorner = (
	arr: Float64Array | Float32Array,
	w: number,
	ix: number,
	iy: number,
	fx: number,
	fy: number
) => {
	const i00 = iy * w + ix;
	const omx = 1 - fx;
	const omy = 1 - fy;
	return (
		arr[i00] * omx * omy +
		arr[i00 + 1] * fx * omy +
		arr[i00 + w] * omx * fy +
		arr[i00 + w + 1] * fx * fy
	);
};

// Raw {sum, count} over the box [x0, x1] x [y0, y1] (clamped to the grid). The
// box edges move continuously (fractional corners are bilinearly sampled)
// instead of snapping to whole cells, which would re-introduce faint banding.
const boxSums = (
	sat: SummedAreaTable,
	x0: number,
	y0: number,
	x1: number,
	y1: number
): { sum: number; count: number } => {
	const nx = sat.nx;
	const ny = sat.ny;
	const w = nx + 1;

	// Resolve each of the four distinct edge coordinates to a cell index + frac
	// once. Clamp the coordinate to [0, n] and the cell to [0, n-1] (so the +1
	// neighbour stays in range), matching the old sampleIntegral bounds.
	const cx0 = Math.min(Math.max(x0, 0), nx);
	const cx1 = Math.min(Math.max(x1, 0), nx);
	const cy0 = Math.min(Math.max(y0, 0), ny);
	const cy1 = Math.min(Math.max(y1, 0), ny);
	const ix0 = Math.min(cx0 | 0, nx - 1);
	const ix1 = Math.min(cx1 | 0, nx - 1);
	const iy0 = Math.min(cy0 | 0, ny - 1);
	const iy1 = Math.min(cy1 | 0, ny - 1);
	const fx0 = cx0 - ix0;
	const fx1 = cx1 - ix1;
	const fy0 = cy0 - iy0;
	const fy1 = cy1 - iy1;

	const s = sat.sum;
	const c = sat.count;
	const sum =
		sampleCorner(s, w, ix1, iy1, fx1, fy1) -
		sampleCorner(s, w, ix0, iy1, fx0, fy1) -
		sampleCorner(s, w, ix1, iy0, fx1, fy0) +
		sampleCorner(s, w, ix0, iy0, fx0, fy0);
	const count =
		sampleCorner(c, w, ix1, iy1, fx1, fy1) -
		sampleCorner(c, w, ix0, iy1, fx0, fy1) -
		sampleCorner(c, w, ix1, iy0, fx1, fy0) +
		sampleCorner(c, w, ix0, iy0, fx0, fy0);
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
