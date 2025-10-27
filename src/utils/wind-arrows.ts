import Pbf from 'pbf';

import { Domain } from '../types';

import { command, writeLayer, zigzag } from './pbf';
import { lat2tile, lon2tile, tile2lat } from './math';

export const generateWindArrows = (
	pbf: Pbf,
	values: Float32Array,
	directions: Float32Array,
	domain: Domain,
	x: number,
	y: number,
	z: number,
	extent: number = 4096,
	margin: number = 0,
	arrows: number = 32
) => {
	const features = [];
	const size = extent / arrows;

	let cursor = [0, 0];

	for (let tileX = 0; tileX < extent + 1; tileX += size) {
		for (let tileY = 0; tileY < extent + 1; tileY += size) {
			let center = [tileX - size / 2, tileY - size / 2];
			const geom = [];

			const properties: { value?: number; direction?: number } = {};

			let [xt0, yt0] = [center[0] - 0.13 * size, center[1] - size * 0.18];
			geom.push(command(1, 1)); // MoveTo
			geom.push(zigzag(xt0));
			geom.push(zigzag(yt0));
			cursor = [xt0, yt0];

			let [xt1, yt1] = [center[0], center[1] - size * 0.4];
			geom.push(command(2, 1)); // LineTo
			geom.push(zigzag(xt1 - cursor[0]));
			geom.push(zigzag(yt1 - cursor[1]));
			cursor = [xt1, yt1];

			[xt1, yt1] = [center[0] + 0.13 * size, center[1] - size * 0.18];
			geom.push(command(2, 1)); // LineTo
			geom.push(zigzag(xt1 - cursor[0]));
			geom.push(zigzag(yt1 - cursor[1]));
			cursor = [xt1, yt1];

			[xt1, yt1] = [center[0], center[1] - size * 0.4];
			geom.push(command(1, 1)); // MoveTo
			geom.push(zigzag(xt0));
			geom.push(zigzag(yt0));
			cursor = [xt1, yt1];

			[xt1, yt1] = [center[0], center[1] + size * 0.4];
			geom.push(command(2, 1)); // LineTo
			geom.push(zigzag(xt1 - cursor[0]));
			geom.push(zigzag(yt1 - cursor[1]));
			cursor = [xt1, yt1];

			// ctx.lineTo(size * 0.63, size * 0.32);
			// ctx.lineTo(size / 2, size * 0.1);
			// ctx.lineTo(size * 0.37, size * 0.32);
			// ctx.lineTo(size / 2, size * 0.1);
			// ctx.lineTo(size / 2, size * 0.95);

			features.push({
				id: tileX + tileY,
				type: 1, // 1 = Point
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
