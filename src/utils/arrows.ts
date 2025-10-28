import Pbf from 'pbf';

import { getInterpolator } from './color-scales';
import { GaussianGrid } from './gaussian';
import { degreesToRadians, rotatePoint, tile2lat, tile2lon } from './math';
import { command, writeLayer, zigzag } from './pbf';
import {
	DynamicProjection,
	Projection,
	ProjectionGrid,
	ProjectionName,
	getIndexAndFractions
} from './projections';

import { ColorScale, DimensionRange, Domain } from '../types';

export const generateArrows = (
	pbf: Pbf,
	values: Float32Array,
	directions: Float32Array,
	domain: Domain,
	ranges: DimensionRange[],
	x: number,
	y: number,
	z: number,
	colorScale: ColorScale,
	extent: number = 4096,
	arrows: number = 27
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

	const interpolator = getInterpolator(colorScale);

	let gaussian;
	if (domain.grid.gaussianGridLatitudeLines) {
		gaussian = new GaussianGrid(domain.grid.gaussianGridLatitudeLines);
	}

	for (let tileY = 0; tileY < extent + 1; tileY += size) {
		let lat = tile2lat(y + tileY / extent, z);
		for (let tileX = 0; tileX < extent + 1; tileX += size) {
			let lon = tile2lon(x + tileX / extent, z);

			const { index, xFraction, yFraction } = getIndexAndFractions(
				lat,
				lon,
				domain,
				projectionGrid,
				ranges,
				[latMin, lonMin, latMax, lonMax]
			);

			let center = [tileX - size / 2, tileY - size / 2];
			const geom = [];

			let speed, direction;
			if (gaussian) {
				speed = gaussian.getLinearInterpolatedValue(values, lat, lon);
				direction = degreesToRadians(
					gaussian.getLinearInterpolatedValue(directions, lat, lon) + 180
				);
			} else {
				speed = interpolator(values, index, xFraction, yFraction, ranges);
				direction = degreesToRadians(
					interpolator(directions, index, xFraction, yFraction, ranges) + 180
				);
			}

			const properties: { value?: number; direction?: number } = {
				value: speed,
				direction: direction
			};

			let rotation = direction;
			let length = 0.95;
			if (speed < 30) {
				length = 0.9;
			}
			if (speed < 20) {
				length = 0.85;
			}
			if (speed < 15) {
				length = 0.8;
			}
			if (speed < 13) {
				length = 0.75;
			}
			if (speed < 9) {
				length = 0.7;
			}
			if (speed < 6) {
				length = 0.6;
			}
			if (speed < 4) {
				length = 0.55;
			}
			if (speed < 2) {
				length = 0.5;
			}

			// left arrow head
			let [xt0, yt0] = rotatePoint(
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
