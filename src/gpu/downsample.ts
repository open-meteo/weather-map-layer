/**
 * NaN-aware box downsampling of a regular grid, for the low-zoom contour
 * pass: below a few screen pixels per cell the bilinear derivative of the
 * full-resolution field speckles, so the isolines sample a coarser copy whose
 * cells stay comfortably larger than a pixel. The particle pass can advect
 * through such a copy of the wind components too (fieldDownsample). Cached
 * per source array (one per timestep/viewport) and factor.
 */
import type { GpuGridUniforms } from './grid-uniforms';

interface DownsampledGrid {
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

/**
 * A box-downsampled copy of a regular or projected grid's values, with the
 * uniforms of the coarse lattice on the same axes. The blocks are anchored to
 * the uncropped grid (`fullOrigin`), so the coarse field stays put when
 * panning re-crops the data. Undefined when the crop is too small.
 */
export const downsampleGrid = (
	values: Float32Array,
	g: GpuGridUniforms,
	factor: number,
	fullOrigin?: [number, number]
): { values: Float32Array; gridUniforms: GpuGridUniforms } | undefined => {
	let skipX = 0;
	let skipY = 0;
	if (fullOrigin) {
		const kx = Math.round((g.originX - fullOrigin[0]) / g.dx);
		const ky = Math.round((g.originY - fullOrigin[1]) / g.dy);
		skipX = ((-kx % factor) + factor) % factor;
		skipY = ((-ky % factor) + factor) % factor;
	}
	const ds = downsampleRegular(values, g.nx, g.ny, factor, skipX, skipY);
	if (!ds) return undefined;

	// Box averaging over factor×factor cells puts the coarse cell centre half
	// a block further in than the (alignment-shifted) origin. On a wrapping
	// grid the seam cell spans what the whole blocks leave of the circle: one
	// step on a full-circle grid (GFS), two on one stored a point short of the
	// seam (ICON) — the native grid's double-width rule (grid-uniforms.ts)
	// applied to the coarse lattice tells them apart.
	const dx = g.dx * factor;
	return {
		values: ds.values,
		gridUniforms: {
			...g,
			nx: ds.nx,
			ny: ds.ny,
			originX: g.originX + g.dx * (skipX + (factor - 1) / 2),
			originY: g.originY + g.dy * (skipY + (factor - 1) / 2),
			dx,
			dy: g.dy * factor,
			wrapLastCellDouble: g.lonWrap && ds.nx * Math.abs(dx) < 360 - 0.5 * Math.abs(dx)
		}
	};
};
