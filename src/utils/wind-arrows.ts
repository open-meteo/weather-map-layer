import Pbf from 'pbf';

import { DimensionRange, Domain } from '../types';

import { command, writeLayer, zigzag } from './pbf';

import { degreesToRadians, rotatePoint, tile2lat, tile2lon } from './math';

import {
	DynamicProjection,
	getIndexAndFractions,
	Projection,
	ProjectionGrid,
	ProjectionName
} from './projections';

export const generateWindArrows = (
	pbf: Pbf,
	values: Float32Array,
	directions: Float32Array,
	domain: Domain,
	ranges: DimensionRange[],
	x: number,
	y: number,
	z: number,
	extent: number = 4096,
	arrows: number = 25
) => {
	const features = [];
	const size = extent / arrows;

	let cursor = [0, 0];

	const lonMin = domain.grid.lonMin + domain.grid.dx * ranges[1]['start'];
	const latMin = domain.grid.latMin + domain.grid.dy * ranges[0]['start'];
	const lonMax = domain.grid.lonMin + domain.grid.dx * ranges[1]['end'];
	const latMax = domain.grid.latMin + domain.grid.dy * ranges[0]['end'];

	let projectionGrid = null;
	if (domain.grid.projection) {
		const projectionName = domain.grid.projection.name as ProjectionName;
		const projection = new DynamicProjection(projectionName, domain.grid.projection) as Projection;
		projectionGrid = new ProjectionGrid(projection, domain.grid, ranges);
	}

	for (let tileY = 0; tileY < extent + 1; tileY += size) {
		let lat = tile2lat(y + tileY / extent, z);
		for (let tileX = 0; tileX < extent + 1; tileX += size) {
			let lon = tile2lon(x + tileX / extent, z);

			const { index } = getIndexAndFractions(lat, lon, domain, projectionGrid, ranges, [
				latMin,
				lonMin,
				latMax,
				lonMax
			]);

			let center = [tileX - size / 2, tileY - size / 2];
			const geom = [];

			const properties: { value?: number; direction?: number } = {
				value: values[index],
				direction: directions[index]
			};

			let rotation = degreesToRadians(directions[index] + 180);

			let [xt0, yt0] = rotatePoint(
				center[0],
				center[1],
				rotation,
				center[0] - 0.13 * size,
				center[1] - size * 0.18
			);

			geom.push(command(1, 1)); // MoveTo
			geom.push(zigzag(xt0));
			geom.push(zigzag(yt0));
			cursor = [xt0, yt0];

			let [xt1, yt1] = rotatePoint(
				center[0],
				center[1],
				rotation,
				center[0],
				center[1] - size * 0.4
			);
			geom.push(command(2, 1)); // LineTo
			geom.push(zigzag(xt1 - cursor[0]));
			geom.push(zigzag(yt1 - cursor[1]));
			cursor = [xt1, yt1];

			[xt1, yt1] = rotatePoint(
				center[0],
				center[1],
				rotation,
				center[0] + 0.13 * size,
				center[1] - size * 0.18
			);
			geom.push(command(2, 1)); // LineTo
			geom.push(zigzag(xt1 - cursor[0]));
			geom.push(zigzag(yt1 - cursor[1]));
			cursor = [xt1, yt1];

			[xt1, yt1] = rotatePoint(center[0], center[1], rotation, center[0], center[1] - size * 0.4);
			geom.push(command(1, 1)); // MoveTo
			geom.push(zigzag(xt1 - cursor[0]));
			geom.push(zigzag(yt1 - cursor[1]));
			cursor = [xt1, yt1];

			[xt1, yt1] = rotatePoint(center[0], center[1], rotation, center[0], center[1] + size * 0.4);
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
