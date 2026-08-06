/**
 * One point per lattice cell carrying the speed and the direction, for
 * consumers that draw arrows or barbs as map symbols rather than as tile
 * geometry.
 *
 * Symbols are laid out in screen space, so an icon keeps its size while the
 * map zooms, where `generateArrows`/`generateWindBarbs` bake the shape into
 * tile coordinates and it grows with the tile until the next zoom level loads.
 * The shape lives in the icon here; the tile only says where and which way.
 */
import { GridInterface } from '../grids';
import { PbfWriter } from 'pbf';

import { type ResolvedClippingOptions, createClippingTester } from './clipping';
import { VECTOR_TILE_EXTENT } from './constants';
import { tile2lat, tile2lon } from './math';
import { command, writeLayer, zigzag } from './pbf';

import { InterpolationMethod } from '../types';

/** Points across a tile when the caller does not say. */
export const DEFAULT_WIND_POINTS = 28;
/** Bounds, since the cost of the lattice grows with the square of the count. */
export const MIN_WIND_POINTS = 2;
export const MAX_WIND_POINTS = 200;

export const generateWindPoints = (
	pbf: PbfWriter,
	values: Float32Array,
	directions: Float32Array,
	grid: GridInterface,
	x: number,
	y: number,
	z: number,
	clippingOptions: ResolvedClippingOptions | undefined,
	interpolation: InterpolationMethod = 'linear',
	extent: number = VECTOR_TILE_EXTENT,
	points: number = DEFAULT_WIND_POINTS
) => {
	// Every point is drawn, so this lattice alone sets the density: symbols are
	// left to overlap rather than collide, which would thin diagonal icons more
	// than upright ones (their axis-aligned collision box is larger) and make
	// the density depend on the wind direction.
	//
	// The count is what the caller asks for, rather than a spacing this would
	// have to round: a tile is TILE_PX wide at an integer zoom, so `points` per
	// tile is exactly TILE_PX / points pixels apart, with nothing left over.
	points = Math.min(MAX_WIND_POINTS, Math.max(MIN_WIND_POINTS, Math.round(points)));
	// The world tiles are drawn much larger than their nominal size
	if (z === 0) {
		points *= 2;
	}
	if (z === 1) {
		points = Math.round(points * 1.55);
	}

	const features = [];
	const isInsideClip = createClippingTester(clippingOptions);

	// Stepped by index rather than by accumulating the spacing, which drifts, and
	// anchored at the tile corner so the lattice keeps lining up with the zoom
	// level below it, instead of interleaving with it while the map zooms.
	// Symbols are drawn across tile boundaries, and MapLibre drops the ones
	// anchored exactly on the far edge, so no row is emitted there.
	for (let row = 0; row < points; row++) {
		const tileY = (row * extent) / points;
		const lat = tile2lat(y + tileY / extent, z);
		for (let column = 0; column < points; column++) {
			const tileX = (column * extent) / points;
			const lon = tile2lon(x + tileX / extent, z);

			if (isInsideClip && !isInsideClip(lon, lat)) {
				continue;
			}

			const value = grid.getInterpolatedValue(values, lat, lon, interpolation);
			if (!isFinite(value)) {
				continue;
			}
			// Degrees, the direction the flow comes from, as the renderer's
			// rotation expressions expect
			const direction = grid.getLinearInterpolatedValue(directions, lat, lon);

			features.push({
				id: tileX + tileY,
				type: 1, // 1 = Point
				properties: { value, direction, latitude: lat },
				geom: [command(1, 1), zigzag(Math.round(tileX)), zigzag(Math.round(tileY))]
			});
		}
	}

	// write Layer
	pbf.writeMessage(3, writeLayer, {
		name: 'wind-points',
		extent,
		features
	});
};
