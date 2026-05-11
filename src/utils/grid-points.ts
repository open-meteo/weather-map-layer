import { GridInterface } from '../grids';
import Pbf from 'pbf';

import { ResolvedClippingOptions, createClippingTester } from './clipping';
import { VECTOR_TILE_EXTENT } from './constants';
import { lat2tile, lon2tile, tile2lat } from './math';
import { command, writeLayer, zigzag } from './pbf';

import { Bounds } from '../types';

/**
 * Convert tile x coordinate to longitude without modular wrapping.
 * Unlike tile2lon, this does NOT wrap via % 360, so tile2lonUnwrapped(2^z, z) = 180
 */
const tile2lonUnwrapped = (x: number, z: number): number => {
	return (x / Math.pow(2, z)) * 360 - 180;
};

/**
 * Generate the PBF grid-point layer for a single tile.
 * Computes tile geographic bounds that intersects with `clippingBounds` if defined
 */
export const generateGridPoints = (
	pbf: Pbf,
	grid: GridInterface,
	values: Float32Array,
	directions: Float32Array | undefined,
	x: number,
	y: number,
	z: number,
	clippingOptions?: ResolvedClippingOptions,
	extent: number = VECTOR_TILE_EXTENT,
	margin: number = 0
) => {
	const features: Array<{
		id: number;
		type: number;
		properties: { value?: number; direction?: number };
		geom: number[];
	}> = [];

	const isInsideClip = createClippingTester(clippingOptions);

	const tileOffsetX = x * extent;
	const tileOffsetY = y * extent;

	// Tile geographic bounds with margin.
	// Use unwrapped longitude to avoid the east edge of the last tile
	const marginFrac = margin / extent;
	const tileBounds: Bounds = [
		tile2lonUnwrapped(x - marginFrac, z),
		tile2lat(y + 1 + marginFrac, z),
		tile2lonUnwrapped(x + 1 + marginFrac, z),
		tile2lat(y - marginFrac, z)
	];

	const clippingBounds = clippingOptions?.bounds;

	// Intersect tile bounds with clippingBounds when defined.
	const iterBounds: Bounds = clippingBounds
		? [
				Math.max(tileBounds[0], clippingBounds[0]),
				Math.max(tileBounds[1], clippingBounds[1]),
				Math.min(tileBounds[2], clippingBounds[2]),
				Math.min(tileBounds[3], clippingBounds[3])
			]
		: tileBounds;

	// If the intersection is empty, skip iteration entirely.
	if (iterBounds[0] > iterBounds[2] || iterBounds[1] > iterBounds[3]) {
		pbf.writeMessage(3, writeLayer, { name: 'grid', extent, features });
		return;
	}

	grid.forEachPoint(({ index, lat, lon }) => {
		const worldPx = Math.floor(lon2tile(lon, z) * extent);
		const worldPy = Math.floor(lat2tile(lat, z) * extent);

		const px = worldPx - tileOffsetX;
		const py = worldPy - tileOffsetY;
		if (px < -margin || px > extent + margin) return;
		if (py < -margin || py > extent + margin) return;

		const value = values[index];
		if (isNaN(value)) return;

		if (isInsideClip && !isInsideClip(lon, lat)) {
			return;
		}

		const properties: { value?: number; direction?: number } = {};
		properties.value = Number(value.toFixed(2));
		if (directions) {
			properties.direction = directions[index];
		}

		features.push({
			id: index,
			type: 1, // Point
			properties,
			geom: [command(1, 1), zigzag(px), zigzag(py)]
		});
	}, iterBounds);

	// write Layer
	pbf.writeMessage(3, writeLayer, {
		name: 'grid',
		extent,
		features
	});
};
