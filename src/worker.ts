import Pbf from 'pbf';

import { generateArrows } from './utils/arrows';
import { generateContours } from './utils/contours';
import { generateGridPoints } from './utils/grid-points';
import { tile2lat, tile2lon } from './utils/math';
import { getColor } from './utils/styling';

import { GridFactory } from './grids/index';

import { TileRequest } from './types';

self.onmessage = async (message: MessageEvent<TileRequest>): Promise<void> => {
	const key = message.data.key;
	const { z, x, y } = message.data.tileIndex;
	const values = message.data.data.values;
	const ranges = message.data.dataOptions.ranges;
	const domain = message.data.dataOptions.domain;
	const colorScale = message.data.renderOptions.colorScale;
	const tileSize =
		message.data.renderOptions.tileSize * message.data.renderOptions.resolutionFactor;

	if (!values) {
		throw new Error('No values provided');
	}

	if (message.data.type == 'getImage') {
		const pixels = tileSize * tileSize;
		// Initialized with zeros
		const rgba = new Uint8ClampedArray(pixels * 4);

		const grid = GridFactory.create(domain.grid, ranges);

		for (let i = 0; i < tileSize; i++) {
			const lat = tile2lat(y + i / tileSize, z);
			for (let j = 0; j < tileSize; j++) {
				const ind = j + i * tileSize;
				const lon = tile2lon(x + j / tileSize, z);
				const px = grid.getLinearInterpolatedValue(values, lat, lon);

				if (isFinite(px)) {
					const color = getColor(colorScale, px);
					rgba[4 * ind] = color[0];
					rgba[4 * ind + 1] = color[1];
					rgba[4 * ind + 2] = color[2];
					rgba[4 * ind + 3] = 255 * color[3];
				}
			}
		}

		const imageBitmap = await createImageBitmap(new ImageData(rgba, tileSize, tileSize), {
			premultiplyAlpha: 'premultiply'
		});
		postMessage({ type: 'returnImage', tile: imageBitmap, key: key }, { transfer: [imageBitmap] });
	} else if (message.data.type == 'getArrayBuffer') {
		const directions = message.data.data.directions;

		const pbf = new Pbf();

		if (message.data.renderOptions.drawGrid) {
			if (domain.grid.type !== 'regular') {
				throw new Error('Only regular grid types supported');
			}
			generateGridPoints(pbf, values, directions, domain.grid, x, y, z);
		}
		if (message.data.renderOptions.drawArrows && directions) {
			generateArrows(pbf, values, directions, domain, ranges, x, y, z);
		}
		if (message.data.renderOptions.drawContours) {
			const intervals = message.data.renderOptions.intervals;
			const grid = GridFactory.create(domain.grid, ranges);
			generateContours(pbf, values, grid, x, y, z, tileSize, intervals);
		}

		const arrayBuffer = pbf.finish();
		postMessage(
			{ type: 'returnArrayBuffer', tile: arrayBuffer.buffer, key: key },
			{ transfer: [arrayBuffer.buffer] }
		);
	}
};
