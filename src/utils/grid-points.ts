import Pbf from 'pbf';

import { VECTOR_TILE_EXTENT } from './constants';
import { lat2tile, lon2tile } from './math';
import { command, writeLayer, zigzag } from './pbf';

import { RegularGridData } from '../types';

export const generateGridPoints = (
	pbf: Pbf,
	values: Float32Array,
	directions: Float32Array | undefined,
	grid: RegularGridData,
	x: number,
	y: number,
	z: number,
	extent: number = VECTOR_TILE_EXTENT,
	margin: number = 0
) => {
	const features = [];

	for (let j = 0; j < grid.ny; j++) {
		const lat = grid.latMin + grid.dy * j;
		// if (lat > minLatTile && lat < maxLatTile) {
		const worldPy = Math.floor(lat2tile(lat, z) * extent);
		const py = worldPy - y * extent;
		if (py > -margin && py <= extent + margin) {
			for (let i = 0; i < grid.nx; i++) {
				const lon = grid.lonMin + grid.dx * i;
				// if (lon > minLonTile && lon < maxLonTile) {
				const worldPx = Math.floor(lon2tile(lon, z) * extent);
				const px = worldPx - x * extent;
				if (px > -margin && px <= extent + margin) {
					const index = j * grid.nx + i;
					const value = values[index];

					const properties: { value?: number; direction?: number } = {};
					properties.value = Number(values[index].toFixed(2));
					if (directions) {
						properties.direction = directions[index];
					}

					if (!isNaN(value)) {
						features.push({
							id: index,
							type: 1, // 1 = Point
							properties: properties,
							geom: [
								command(1, 1), // MoveTo
								zigzag(px),
								zigzag(py)
							]
						});
					}
				}
			}
		}
	}
	// write Layer
	pbf.writeMessage(3, writeLayer, {
		name: 'grid',
		extent,
		features: features
	});
};
