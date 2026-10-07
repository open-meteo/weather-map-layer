import type { RgbaTile } from '../types';

/**
 * The tile at `levels` zooms below `parent` whose quadrant path is `(x, y)`
 * within it, as a map client would show it by magnifying the parent: the
 * parent's sub-rectangle upsampled bilinearly. Lets a server answer requests
 * past a domain's maximum zoom from the tile at that zoom.
 *
 * @param parent - The tile at the maximum zoom.
 * @param levels - How many zooms below the parent the requested tile lies.
 * @param x - The requested tile's column, relative to the parent's column at that zoom.
 * @param y - The requested tile's row, relative to the parent's row at that zoom.
 */
export const overzoomTile = (parent: RgbaTile, levels: number, x: number, y: number): RgbaTile => {
	const size = parent.width;
	const scale = 2 ** levels;
	const span = size / scale;
	const p = parent.rgba;
	const rgba = new Uint8ClampedArray(size * size * 4);
	for (let v = 0; v < size; v++) {
		// Sample at the pixel centre, on the parent's pixel grid
		const sy = y * span + (v + 0.5) / scale - 0.5;
		const y0 = Math.max(0, Math.min(size - 1, Math.floor(sy)));
		const y1 = Math.min(size - 1, y0 + 1);
		const fy = Math.max(0, sy - y0);
		for (let u = 0; u < size; u++) {
			const sx = x * span + (u + 0.5) / scale - 0.5;
			const x0 = Math.max(0, Math.min(size - 1, Math.floor(sx)));
			const x1 = Math.min(size - 1, x0 + 1);
			const fx = Math.max(0, sx - x0);
			const i = (v * size + u) * 4;
			const i00 = (y0 * size + x0) * 4;
			const i01 = (y0 * size + x1) * 4;
			const i10 = (y1 * size + x0) * 4;
			const i11 = (y1 * size + x1) * 4;
			for (let k = 0; k < 4; k++) {
				rgba[i + k] =
					(p[i00 + k] * (1 - fx) + p[i01 + k] * fx) * (1 - fy) +
					(p[i10 + k] * (1 - fx) + p[i11 + k] * fx) * fy;
			}
		}
	}
	return { width: size, height: parent.height, rgba };
};
