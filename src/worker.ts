import Pbf from 'pbf';

import { generateArrows } from './utils/arrows';
import { MS_TO_KMH } from './utils/constants';
import { generateContours } from './utils/contours';
import { generateGridPoints } from './utils/grid-points';
import { tile2lat, tile2lon } from './utils/math';
import { getColor, getOpacity } from './utils/styling';
import { hideZero } from './utils/variables';

import { GridFactory } from './grids/index';
import { TileRequest } from './worker-pool';

self.onmessage = async (message: MessageEvent<TileRequest>): Promise<void> => {
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

		if (!values) {
			throw new Error('No values provided');
		}

		// const interpolationMethod = getInterpolationMethod(colorScale);
		const grid = GridFactory.create(domain.grid, ranges);

		const isWind = variable.value.includes('wind');
		const isHideZero = hideZero.includes(variable.value);
		const isWeatherCode = variable.value === 'weather_code';

		for (let i = 0; i < tileSize; i++) {
			const lat = tile2lat(y + i / tileSize, z);
			for (let j = 0; j < tileSize; j++) {
				const ind = j + i * tileSize;
				const lon = tile2lon(x + j / tileSize, z);
				let px = grid.getLinearInterpolatedValue(values, lat, lon);

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

		if (!values) {
			throw new Error('No values provided');
		}

		const pbf = new Pbf();

		if (key.includes('grid=true')) {
			if (domain.grid.type !== 'regular') {
				throw new Error('Only regular grid types supported');
			}
			generateGridPoints(pbf, values, directions, domain.grid, x, y, z);
		}
		if (key.includes('arrows=true') && directions) {
			generateArrows(pbf, values, directions, domain, ranges, x, y, z, colorScale);
		}
		if (key.includes('contours=true')) {
			const grid = GridFactory.create(domain.grid, ranges);
			generateContours(pbf, values, grid, x, y, z, interval ? interval : 2);
		}

		const arrayBuffer = pbf.finish();
		postMessage(
			{ type: 'returnArrayBuffer', tile: arrayBuffer.buffer, key: key },
			{ transfer: [arrayBuffer.buffer] }
		);
	}
};
