/**
 * NaN-aware box downsampling of a regular grid, for the low-zoom contour
 * pass: below a few screen pixels per cell the bilinear derivative of the
 * full-resolution field speckles, so the isolines sample a coarser copy whose
 * cells stay comfortably larger than a pixel. Cached per source array (one
 * per timestep/viewport) and factor.
 */

export interface DownsampledGrid {
	values: Float32Array;
	nx: number;
	ny: number;
}

const cache = new WeakMap<Float32Array, Map<string, DownsampledGrid>>();

export const downsampleRegular = (
	values: Float32Array,
	nx: number,
	ny: number,
	factor: number,
	/** Cells skipped at the start of each axis, aligning blocks across crops. */
	skipX = 0,
	skipY = 0
): DownsampledGrid | undefined => {
	const outNx = Math.floor((nx - skipX) / factor);
	const outNy = Math.floor((ny - skipY) / factor);
	if (outNx < 2 || outNy < 2) return undefined;

	let byFactor = cache.get(values);
	const key = `${factor}:${skipX}:${skipY}`;
	const cached = byFactor?.get(key);
	if (cached) return cached;

	const out = new Float32Array(outNx * outNy);
	for (let j = 0; j < outNy; j++) {
		for (let i = 0; i < outNx; i++) {
			let sum = 0;
			let count = 0;
			const j0 = skipY + j * factor;
			const i0 = skipX + i * factor;
			for (let dj = 0; dj < factor; dj++) {
				const row = (j0 + dj) * nx + i0;
				for (let di = 0; di < factor; di++) {
					const v = values[row + di];
					if (Number.isFinite(v)) {
						sum += v;
						count++;
					}
				}
			}
			out[j * outNx + i] = count > 0 ? sum / count : NaN;
		}
	}

	const result: DownsampledGrid = { values: out, nx: outNx, ny: outNy };
	if (!byFactor) {
		byFactor = new Map();
		cache.set(values, byFactor);
	}
	byFactor.set(key, result);
	return result;
};
