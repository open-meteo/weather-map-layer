import Pbf from 'pbf';

import { generateArrows } from './utils/arrows';
import { getColor, getInterpolator, getOpacity } from './utils/color-scales';
import { MS_TO_KMH } from './utils/constants';
import { generateContours } from './utils/contours';
import { GaussianGrid } from './utils/gaussian';
import { generateGrid } from './utils/grid';
import { tile2lat, tile2lon } from './utils/math';
import {
	DynamicProjection,
	type Projection,
	ProjectionGrid,
	ProjectionName,
	getIndexAndFractions
} from './utils/projections';
import { hideZero } from './utils/variables';

self.onmessage = async (message) => {
	if (message.data.type == 'getImage') {
		const key = message.data.key;

		const x = message.data.x;
		const y = message.data.y;
		const z = message.data.z;

		const dark = message.data.dark;
		const values = message.data.data.values;
		const ranges = message.data.ranges;
		const tileSize = message.data.tileSize;
		const domain = message.data.domain;
		const variable = message.data.variable;
		const colorScale = message.data.colorScale;

		const pixels = tileSize * tileSize;
		const rgba = new Uint8ClampedArray(pixels * 4);

		let projectionGrid = null;
		if (domain.grid.projection) {
			const projectionName = domain.grid.projection.name as ProjectionName;
			const projection = new DynamicProjection(
				projectionName,
				domain.grid.projection
			) as Projection;
			projectionGrid = new ProjectionGrid(projection, domain.grid, ranges);
		}

		const interpolator = getInterpolator(colorScale);

		const lonMin = domain.grid.lonMin + domain.grid.dx * ranges[1]['start'];
		const latMin = domain.grid.latMin + domain.grid.dy * ranges[0]['start'];
		const lonMax = domain.grid.lonMin + domain.grid.dx * ranges[1]['end'];
		const latMax = domain.grid.latMin + domain.grid.dy * ranges[0]['end'];

		let gaussian;
		if (domain.grid.gaussianGridLatitudeLines) {
			gaussian = new GaussianGrid(domain.grid.gaussianGridLatitudeLines);
		}

		const isWind = variable.value.includes('wind');
		const isHideZero = hideZero.includes(variable.value);
		const isWeatherCode = variable.value === 'weather_code';

		for (let i = 0; i < tileSize; i++) {
			const lat = tile2lat(y + i / tileSize, z);
			for (let j = 0; j < tileSize; j++) {
				const ind = j + i * tileSize;
				const lon = tile2lon(x + j / tileSize, z);

				let px = NaN;
				if (gaussian && domain.grid.gaussianGridLatitudeLines) {
					px = gaussian.getLinearInterpolatedValue(values, lat, lon);
				} else {
					const { index, xFraction, yFraction } = getIndexAndFractions(
						lat,
						lon,
						domain,
						projectionGrid,
						ranges,
						[latMin, lonMin, latMax, lonMax]
					);

					px = interpolator(values as Float32Array, index, xFraction, yFraction, ranges);
				}

				if (isHideZero) {
					if (px < 0.25) {
						px = NaN;
					}
				}

				if (isWind) {
					px = px * MS_TO_KMH;
				}

				if (isNaN(px) || px === Infinity || isWeatherCode) {
					rgba[4 * ind] = 0;
					rgba[4 * ind + 1] = 0;
					rgba[4 * ind + 2] = 0;
					rgba[4 * ind + 3] = 0;
				} else {
					const color = getColor(colorScale, px);

					if (color) {
						rgba[4 * ind] = color[0];
						rgba[4 * ind + 1] = color[1];
						rgba[4 * ind + 2] = color[2];
						rgba[4 * ind + 3] = getOpacity(variable.value, px, dark, colorScale);
					}
				}
			}
		}

		const imageBitmap = await createImageBitmap(new ImageData(rgba, tileSize, tileSize), {
			premultiplyAlpha: 'premultiply'
		});
		postMessage({ type: 'returnImage', tile: imageBitmap, key: key }, { transfer: [imageBitmap] });
	} else if (message.data.type == 'getArrayBuffer') {
		const key = message.data.key;

		const x = message.data.x;
		const y = message.data.y;
		const z = message.data.z;

		const values = message.data.data.values;
		const ranges = message.data.ranges;
		const domain = message.data.domain;
		const interval = message.data.interval;
		const directions = message.data.data.directions;
		const colorScale = message.data.colorScale;

		const pbf = new Pbf();

		if (key.includes('grid=true')) {
			generateGrid(pbf, values, directions, domain, x, y, z);
		}
		if (key.includes('arrows=true') && directions) {
			generateArrows(pbf, values, directions, domain, ranges, x, y, z, colorScale);
		}
		if (key.includes('contours=true')) {
			generateContours(pbf, values, domain, ranges, x, y, z, interval ? interval : 2);
		}

		const arrayBuffer = pbf.finish();
		postMessage(
			{ type: 'returnArrayBuffer', tile: arrayBuffer.buffer, key: key },
			{ transfer: [arrayBuffer.buffer] }
		);
	}
};
