import Pbf from 'pbf';

import { generateArrows } from './utils/arrows';
import { generateContours } from './utils/contours';
import { generateGridPoints } from './utils/grid-points';
import { checkAgainstBounds, lat2tile, lon2tile, tile2lat, tile2lon } from './utils/math';
import { getColor } from './utils/styling';

import { GridFactory } from './grids/index';

import { TileRequest } from './types';

self.onmessage = async (message: MessageEvent<TileRequest>): Promise<void> => {
	const key = message.data.key;
	const { z, x, y } = message.data.tileIndex;
	const values = message.data.data.values;
	const ranges = message.data.ranges;
	const domain = message.data.dataOptions.domain;
	const tileSize = message.data.renderOptions.tileSize;
	const colorScale = message.data.renderOptions.colorScale;
	const clippingOptions = message.data.clippingOptions;

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

			if (clippingOptions?.bounds)
				if (checkAgainstBounds(lat, clippingOptions.bounds[1], clippingOptions.bounds[3])) continue;

			for (let j = 0; j < tileSize; j++) {
				const ind = j + i * tileSize;
				const lon = tile2lon(x + j / tileSize, z);

				if (clippingOptions?.bounds)
					if (checkAgainstBounds(lon, clippingOptions.bounds[0], clippingOptions.bounds[2]))
						continue;

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

		const imageData = new ImageData(rgba, tileSize, tileSize);

		const canvas = new OffscreenCanvas(tileSize, tileSize);
		const context = canvas.getContext('2d');

		if (!context) {
			throw new Error('Could not initialise canvas context');
		}

		context.putImageData(imageData, 0, 0);

		let blob;
		if (clippingOptions && clippingOptions.polygons) {
			// create 2nd OffscreenCanvas to handle clipping
			const clipCanvas = new OffscreenCanvas(tileSize, tileSize);
			const clipContext = clipCanvas.getContext('2d');

			if (!clipContext) {
				throw new Error('Could not initialise canvas context');
			}

			for (const polygon of clippingOptions.polygons) {
				clipContext.beginPath();
				for (const coordinate of polygon) {
					for (const [index, [polyX, polyY]] of coordinate.entries()) {
						const polyXtile = (lon2tile(polyX, z) - x) * tileSize;
						const polyYtile = (lat2tile(polyY, z) - y) * tileSize;
						if (index === 0) {
							clipContext.moveTo(polyXtile, polyYtile);
						} else {
							clipContext.lineTo(polyXtile, polyYtile);
						}
					}
				}
				clipContext.closePath();
			}

			clipContext.clip('nonzero');
			clipContext.drawImage(canvas, 0, 0);

			blob = await clipCanvas.convertToBlob({ type: 'image/png' });
		} else {
			blob = await canvas.convertToBlob({ type: 'image/png' });
		}

		const arrayBuffer = await blob.arrayBuffer();
		postMessage({ type: 'returnImage', tile: arrayBuffer, key: key }, { transfer: [arrayBuffer] });
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
			generateArrows(pbf, values, directions, domain, ranges, x, y, z, clippingOptions);
		}
		if (message.data.renderOptions.drawContours) {
			const intervals = message.data.renderOptions.intervals;
			const grid = GridFactory.create(domain.grid, ranges);
			generateContours(pbf, values, grid, x, y, z, tileSize, intervals, clippingOptions);
		}

		const arrayBuffer = pbf.finish();
		postMessage(
			{ type: 'returnArrayBuffer', tile: arrayBuffer.buffer, key: key },
			{ transfer: [arrayBuffer.buffer] }
		);
	}
};
