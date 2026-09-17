import { type ResolvedClippingOptions, createClippingTester } from './clipping';
import { tile2lat, tile2lon } from './math';

/**
 * Visit every point of an n×n lattice laid over tile x/y/z, in tile units of
 * `extent`, skipping points outside the clipping region. Shared by the arrow
 * and barb generators so both place their shapes on the same grid.
 *
 * Stepped by index rather than by accumulating the spacing, which drifts. The
 * far edge is included: a shape there is clipped to its own tile, and the
 * neighbouring tile draws the other half of it.
 */
export const forEachLatticePoint = (
	lattice: number,
	x: number,
	y: number,
	z: number,
	extent: number,
	clippingOptions: ResolvedClippingOptions | undefined,
	visit: (tileX: number, tileY: number, lat: number, lon: number) => void
): void => {
	const isInsideClip = createClippingTester(clippingOptions);
	for (let row = 0; row <= lattice; row++) {
		const tileY = (row * extent) / lattice;
		const lat = tile2lat(y + tileY / extent, z);
		for (let column = 0; column <= lattice; column++) {
			const tileX = (column * extent) / lattice;
			const lon = tile2lon(x + tileX / extent, z);
			if (isInsideClip && !isInsideClip(lon, lat)) {
				continue;
			}
			visit(tileX, tileY, lat, lon);
		}
	}
};
