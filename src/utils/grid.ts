import Pbf from 'pbf';

import { Domain } from '../types';
import { lat2tile, lon2tile } from './math';
import { command, writeLayer, zigzag } from './pbf';

export const generateGrid = (
	pbf: Pbf,
	values: Float32Array,
	directions: Float32Array,
	domain: Domain,
	x: number,
	y: number,
	z: number,
	extent: number = 4096,
	margin: number = 0
) => {
	const features = [];

	// let mod = 4;
	// if (z > 1) {
	// 	mod = 3;
	// }
	// if (z > 2) {
	// 	mod = 2;
	// }
	// if (z > 3) {
	// 	mod = 1;
	// }

	for (let j = 0; j < domain.grid.ny; j++) {
		const lat = domain.grid.latMin + domain.grid.dy * j;
		// if (lat > minLatTile && lat < maxLatTile) {
		const worldPy = Math.floor(lat2tile(lat, z) * extent);
		const py = worldPy - y * extent;
		if (py > -margin && py <= extent + margin) {
			for (let i = 0; i < domain.grid.nx; i++) {
				const lon = domain.grid.lonMin + domain.grid.dx * i;
				// if (lon > minLonTile && lon < maxLonTile) {
				const worldPx = Math.floor(lon2tile(lon, z) * extent);
				const px = worldPx - x * extent;
				if (px > -margin && px <= extent + margin) {
					const index = j * domain.grid.nx + i;
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
