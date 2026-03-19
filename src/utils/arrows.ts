import { GridFactory } from '../grids';
import Pbf from 'pbf';
import inside from 'point-in-polygon-hao';

import { VECTOR_TILE_EXTENT } from './constants';
import { degreesToRadians, rotatePoint, tile2lat, tile2lon } from './math';
import { command, writeLayer, zigzag } from './pbf';

import { ClippingOptions, DimensionRange, Domain } from '../types';

export const generateArrows = (
	pbf: Pbf,
	values: Float32Array,
	directions: Float32Array,
	domain: Domain,
	ranges: DimensionRange[] | null,
	x: number,
	y: number,
	z: number,
	clippingOptions: ClippingOptions,
	extent: number = VECTOR_TILE_EXTENT,
	arrows: number = 25
) => {
	if (z === 0) {
		arrows = 50;
	}
	if (z === 1) {
		arrows = 40;
	}

	const features = [];
	const size = extent / arrows;

	let cursor = [0, 0];
	const grid = GridFactory.create(domain.grid, ranges);

	for (let tileY = 0; tileY < extent + 1; tileY += size) {
		const lat = tile2lat(y + tileY / extent, z);
		for (let tileX = 0; tileX < extent + 1; tileX += size) {
			const lon = tile2lon(x + tileX / extent, z);

			// correct center would be (- size / 2 ), but it looks way better on the edges when center is far end of box
			// const center = [tileX - size / 2, tileY - size / 2];
			const center = [tileX, tileY];
			const geom = [];

			let insideClip = true;
			if (clippingOptions && clippingOptions.polygons) {
				for (const polygon of clippingOptions.polygons) {
					if (!inside([lon, lat], polygon)) {
						insideClip = false;
					}
				}
			}
			if (!insideClip) {
				continue;
			}

			const speed = grid.getLinearInterpolatedValue(values, lat, lon);
			const direction = degreesToRadians(
				grid.getLinearInterpolatedValue(directions, lat, lon) + 180
			);

			const properties: { value?: number; direction?: number } = {
				value: speed,
				direction: direction
			};

			const rotation = direction;
			let length = 0.85;
			if (speed < 20) {
				length = 0.8;
			}
			if (speed < 10) {
				length = 0.75;
			}
			if (speed < 5) {
				length = 0.7;
			}
			if (speed < 3) {
				length = 0.6;
			}
			if (speed < 2) {
				length = 0.55;
			}
			if (speed < 1) {
				length = 0.5;
			}

			// left arrow head
			const [xt0, yt0] = rotatePoint(
				center[0],
				center[1],
				rotation,
				center[0] - 0.13 * size,
				center[1] - ((size * length) / 2 - size * 0.22)
			);
			geom.push(command(1, 1)); // MoveTo
			geom.push(zigzag(xt0));
			geom.push(zigzag(yt0));
			cursor = [xt0, yt0];

			// arrow head middle
			let [xt1, yt1] = rotatePoint(
				center[0],
				center[1],
				rotation,
				center[0],
				center[1] - (size * length) / 2
			);
			geom.push(command(2, 1)); // LineTo
			geom.push(zigzag(xt1 - cursor[0]));
			geom.push(zigzag(yt1 - cursor[1]));
			cursor = [xt1, yt1];

			// right arrow head
			[xt1, yt1] = rotatePoint(
				center[0],
				center[1],
				rotation,
				center[0] + 0.13 * size,
				center[1] - ((size * length) / 2 - size * 0.22)
			);
			geom.push(command(2, 1)); // LineTo
			geom.push(zigzag(xt1 - cursor[0]));
			geom.push(zigzag(yt1 - cursor[1]));
			cursor = [xt1, yt1];

			// arrow head middle
			[xt1, yt1] = rotatePoint(
				center[0],
				center[1],
				rotation,
				center[0],
				center[1] - (size * length) / 2
			);
			geom.push(command(1, 1)); // MoveTo
			geom.push(zigzag(xt1 - cursor[0]));
			geom.push(zigzag(yt1 - cursor[1]));
			cursor = [xt1, yt1];

			// arrow bottom middle
			[xt1, yt1] = rotatePoint(
				center[0],
				center[1],
				rotation,
				center[0],
				center[1] + (size * length) / 2
			);
			geom.push(command(2, 1)); // LineTo
			geom.push(zigzag(xt1 - cursor[0]));
			geom.push(zigzag(yt1 - cursor[1]));
			cursor = [xt1, yt1];

			features.push({
				id: tileX + tileY,
				type: 2, // 2 = LineString
				properties: properties,
				geom: geom
			});
		}
	}

	// write Layer
	pbf.writeMessage(3, writeLayer, {
		name: 'wind-arrows',
		extent,
		features: features
	});
};
