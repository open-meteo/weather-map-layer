import { PbfWriter } from 'pbf';

import { generateArrows } from './utils/arrows';
import { checkAgainstBounds } from './utils/bounds';
import { clipRasterToPolygons } from './utils/clipping';
import { generateContours } from './utils/contours';
import { generateGridPoints } from './utils/grid-points';
import { halfQuantum as computeHalfQuantum, tile2lat, tile2lon } from './utils/math';
import { makeColorSampler } from './utils/styling';

import { GridFactory } from './grids/index';

import { TileRequest, TileTiming } from './types';

self.onmessage = async (message: MessageEvent<TileRequest>): Promise<void> => {
	const key = message.data.key;

	// Handle cancellation messages
	if (message.data.type === 'cancel') {
		postMessage({ type: 'cancelled', key });
		return;
	}

	const { z, x, y } = message.data.tileIndex;
	const values = message.data.data.values;
	const ranges = message.data.ranges;
	const domain = message.data.dataOptions.domain;
	const tileSize = message.data.renderOptions.tileSize;
	const interpolation = message.data.renderOptions.interpolation;
	const smoothFootprint = message.data.renderOptions.smoothFootprint;
	const colorBlend = message.data.renderOptions.colorBlend;
	const colorScale = message.data.renderOptions.colorScale;
	const clippingOptions = message.data.clippingOptions;

	if (!values) {
		throw new Error('No values provided');
	}

	// Per-stage timings, sent back with the result so the pool can log them
	// when benchmarking is enabled (see setTileBenchmark / [wml-bench]).
	const timing: TileTiming = {};
	const started = performance.now();

	if (message.data.type == 'getImage') {
		const pixels = tileSize * tileSize;
		// Initialized with zeros
		const rgba = new Uint8ClampedArray(pixels * 4);

		const grid = GridFactory.create(domain.grid, ranges);

		// Offset the colour threshold by half the data's quantization step so
		// band edges fall inside grid cells (smooth) instead of snapping to the
		// cell corners when a breakpoint coincides with a quantization level.
		const halfQuantum = computeHalfQuantum(values, message.data.data.scaleFactor);

		// Reused per-pixel so colour blending doesn't allocate an array per pixel.
		const colorOut: [number, number, number, number] = [0, 0, 0, 0];

		// Specialise the colour lookup to this tile's scale once, hoisting the
		// per-pixel `switch` and the rgba index division out of the inner loop.
		const sampleColor = makeColorSampler(colorScale, colorBlend);

		const sampleStart = performance.now();

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

				const px = grid.getInterpolatedValue(values, lat, lon, interpolation, smoothFootprint);

				if (isFinite(px)) {
					const color = sampleColor(px + halfQuantum, colorOut);
					rgba[4 * ind] = color[0];
					rgba[4 * ind + 1] = color[1];
					rgba[4 * ind + 2] = color[2];
					rgba[4 * ind + 3] = 255 * color[3];
				}
			}
		}

		timing.sample = performance.now() - sampleStart;
		const canvasStart = performance.now();

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

		timing.canvas = performance.now() - canvasStart;
		timing.total = performance.now() - started;

		postMessage(
			{ type: 'returnImage', tile: imageBitmap, key: key, timing },
			{ transfer: [imageBitmap] }
		);
	} else if (message.data.type == 'getArrayBuffer') {
		const directions = message.data.data.directions;

		const pbf = new PbfWriter();

		const grid = GridFactory.create(domain.grid, ranges);
		if (message.data.renderOptions.drawGrid) {
			const gridStart = performance.now();
			generateGridPoints(pbf, grid, values, directions, x, y, z, clippingOptions);
			timing.grid = performance.now() - gridStart;
		}
		if (message.data.renderOptions.drawArrows && directions) {
			const arrowsStart = performance.now();
			generateArrows(
				pbf,
				values,
				directions,
				grid,
				x,
				y,
				z,
				clippingOptions,
				interpolation,
				smoothFootprint
			);
			timing.arrows = performance.now() - arrowsStart;
		}
		if (message.data.renderOptions.drawContours) {
			const contoursStart = performance.now();
			const intervals = message.data.renderOptions.intervals;
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
				smoothFootprint,
				computeHalfQuantum(values, message.data.data.scaleFactor)
			);
			timing.contours = performance.now() - contoursStart;
		}

		const arrayBuffer = pbf.finish();
		timing.total = performance.now() - started;
		postMessage(
			{ type: 'returnArrayBuffer', tile: arrayBuffer.buffer, key: key, timing },
			{ transfer: [arrayBuffer.buffer] }
		);
	}
};
