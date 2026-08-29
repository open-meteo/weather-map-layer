import { PbfWriter } from 'pbf';

import { generateArrows } from './utils/arrows';
import { checkAgainstBounds } from './utils/bounds';
import { clipRasterToPolygons } from './utils/clipping';
import { generateContours } from './utils/contours';
import { generateGridPoints } from './utils/grid-points';
import { halfQuantum as computeHalfQuantum, tile2lat, tile2lon } from './utils/math';
import { makeColorSampler } from './utils/styling';
import { renderSunShadow } from './utils/sun';

import { GridFactory } from './grids/index';

import { WorkerRequest } from './types';

self.onmessage = async (message: MessageEvent<WorkerRequest>): Promise<void> => {
	const request = message.data;
	const key = request.key;

	// Handle cancellation messages
	if (request.type === 'cancel') {
		postMessage({ type: 'cancelled', key });
		return;
	}

	// Sun shadow tiles are purely analytical: no weather data involved
	if (request.type === 'getShadowImage') {
		const shadowTileSize = request.tileSize;
		const { z, x, y } = request.tileIndex;
		const rgba = new Uint8ClampedArray(shadowTileSize * shadowTileSize * 4);

		renderSunShadow(rgba, shadowTileSize, z, x, y, request.shadowOptions);

		const imageData = new ImageData(rgba, shadowTileSize, shadowTileSize);
		const canvas = new OffscreenCanvas(shadowTileSize, shadowTileSize);
		const context = canvas.getContext('2d');
		if (!context) {
			throw new Error('Could not initialise canvas context');
		}
		context.putImageData(imageData, 0, 0);

		const imageBitmap = canvas.transferToImageBitmap();
		postMessage({ type: 'returnImage', tile: imageBitmap, key: key }, { transfer: [imageBitmap] });
		return;
	}

	const { z, x, y } = request.tileIndex;
	const values = request.data.values;
	const ranges = request.ranges;
	const domain = request.dataOptions.domain;
	const tileSize = request.renderOptions.tileSize;
	const interpolation = request.renderOptions.interpolation;
	const colorBlend = request.renderOptions.colorBlend;
	const colorScale = request.renderOptions.colorScale;
	const clippingOptions = request.clippingOptions;

	if (!values) {
		throw new Error('No values provided');
	}

	if (request.type == 'getImage') {
		const pixels = tileSize * tileSize;
		// Initialized with zeros
		const rgba = new Uint8ClampedArray(pixels * 4);

		const grid = GridFactory.create(domain.grid, ranges);

		// Offset the colour threshold by half the data's quantization step so
		// band edges fall inside grid cells (smooth) instead of snapping to the
		// cell corners when a breakpoint coincides with a quantization level.
		const halfQuantum = computeHalfQuantum(request.data.scaleFactor);

		// Reused per-pixel so colour blending doesn't allocate an array per pixel.
		const colorOut: [number, number, number, number] = [0, 0, 0, 0];

		// Specialise the colour lookup to this tile's scale once, hoisting the
		// per-pixel `switch` and the rgba index division out of the inner loop.
		const sampleColor = makeColorSampler(colorScale, colorBlend);

		// Longitude depends only on the column (j), so resolve all tileSize values
		// once up front instead of re-deriving them for every row — turns tileSize²
		// tile2lon() calls (each with its own Math.pow) into tileSize.
		const lons = new Float64Array(tileSize);
		for (let j = 0; j < tileSize; j++) {
			lons[j] = tile2lon(x + (j + 0.5) / tileSize, z);
		}

		for (let i = 0; i < tileSize; i++) {
			// sample at the pixel centre ((i+0.5)/tileSize), not the top-left
			// corner, so the value is registered where the pixel is displayed
			// (fixes the half-pixel up-left shift visible when zooming)
			const lat = tile2lat(y + (i + 0.5) / tileSize, z);

			if (clippingOptions?.bounds)
				if (checkAgainstBounds(lat, clippingOptions.bounds[1], clippingOptions.bounds[3])) continue;

			for (let j = 0; j < tileSize; j++) {
				const ind = j + i * tileSize;
				const lon = lons[j];

				if (clippingOptions?.bounds)
					if (checkAgainstBounds(lon, clippingOptions.bounds[0], clippingOptions.bounds[2]))
						continue;

				const px = grid.getInterpolatedValue(values, lat, lon, interpolation);

				if (isFinite(px)) {
					const color = sampleColor(px + halfQuantum, colorOut);
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

		let imageBitmap;
		if (clippingOptions?.polygons) {
			imageBitmap = clipRasterToPolygons(canvas, tileSize, z, x, y, clippingOptions);
		} else {
			imageBitmap = canvas.transferToImageBitmap();
		}

		postMessage({ type: 'returnImage', tile: imageBitmap, key: key }, { transfer: [imageBitmap] });
	} else if (request.type == 'getArrayBuffer') {
		const directions = request.data.directions;

		const pbf = new PbfWriter();

		const grid = GridFactory.create(domain.grid, ranges);
		if (request.renderOptions.drawGrid) {
			generateGridPoints(pbf, grid, values, directions, x, y, z, clippingOptions);
		}
		if (request.renderOptions.drawArrows && directions) {
			generateArrows(pbf, values, directions, grid, x, y, z, clippingOptions, interpolation);
		}
		if (request.renderOptions.drawContours) {
			const intervals = request.renderOptions.intervals;
			generateContours(
				pbf,
				values,
				grid,
				x,
				y,
				z,
				tileSize,
				intervals,
				clippingOptions,
				interpolation,
				computeHalfQuantum(request.data.scaleFactor)
			);
		}

		const arrayBuffer = pbf.finish();
		postMessage(
			{ type: 'returnArrayBuffer', tile: arrayBuffer.buffer, key: key },
			{ transfer: [arrayBuffer.buffer] }
		);
	}
};
