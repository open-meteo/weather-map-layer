import { PbfWriter } from 'pbf';

import { generateArrows } from './utils/arrows';
import { checkAgainstBounds } from './utils/bounds';
import { clipRasterToPolygons } from './utils/clipping';
import { generateContours } from './utils/contours';
import { type GridPointSource, generateGridPoints } from './utils/grid-points';
import { halfQuantum as computeHalfQuantum, tile2lat, tile2lon } from './utils/math';
import {
	type ValueSampler,
	type VectorSampler,
	sampleBlendedValue,
	sampleBlendedVector
} from './utils/seamless-sampling';
import { makeColorSampler } from './utils/styling';

import { GridFactory } from './grids/index';

import type { Domain, WorkerRequest } from './types';

self.onmessage = async (message: MessageEvent<WorkerRequest>): Promise<void> => {
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
	const colorBlend = message.data.renderOptions.colorBlend;
	const colorScale = message.data.renderOptions.colorScale;
	const clippingOptions = message.data.clippingOptions;
	const seamlessLayers = message.data.seamlessLayers;
	const isSeamless = seamlessLayers !== undefined && seamlessLayers.length > 0;

	// For non-seamless requests, values must be present
	if (!values && !isSeamless) {
		throw new Error('No values provided');
	}

	if (message.data.type == 'getImage') {
		const pixels = tileSize * tileSize;
		// Initialized with zeros
		const rgba = new Uint8ClampedArray(pixels * 4);

		// Build the per-pixel value sampler
		let getPixelValue: ValueSampler;
		if (seamlessLayers && seamlessLayers.length > 0) {
			// Pre-create all layer grids once (outside the pixel loop for efficiency)
			const layerGrids = seamlessLayers.map((layer) =>
				GridFactory.create(layer.domain.grid, layer.ranges)
			);
			// Full-domain grids (uncropped) so the blend edge distance follows the real
			// domain boundary instead of the viewport crop.
			const fullGrids = seamlessLayers.map((layer) => GridFactory.create(layer.domain.grid, null));
			getPixelValue = sampleBlendedValue(layerGrids, seamlessLayers, fullGrids, interpolation);
		} else {
			const grid = GridFactory.create((domain as Domain).grid, ranges);
			getPixelValue = (lat, lon) => grid.getInterpolatedValue(values!, lat, lon, interpolation);
		}

		// Offset the colour threshold by half the data's quantization step so
		// band edges fall inside grid cells (smooth) instead of snapping to the
		// cell corners when a breakpoint coincides with a quantization level.
		const halfQuantum = computeHalfQuantum(message.data.data.scaleFactor);

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

				const px = getPixelValue(lat, lon);

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
	} else if (message.data.type == 'getArrayBuffer') {
		const directions = message.data.data.directions;
		const renderOptions = message.data.renderOptions;

		const pbf = new PbfWriter();

		// Build per-point samplers + grid-point sources.  For seamless domains these
		// blend across all active layers (finest-first) so arrows, contours and grid
		// points stay continuous instead of cutting off at the finest domain's edge.
		let sampleValue: ValueSampler;
		let sampleVector: VectorSampler;
		let gridSources: GridPointSource[];

		if (seamlessLayers && seamlessLayers.length > 0) {
			const layerGrids = seamlessLayers.map((layer) =>
				GridFactory.create(layer.domain.grid, layer.ranges)
			);
			// Full-domain grids (uncropped) so the blend edge distance follows the real
			// domain boundary instead of the viewport crop.
			const fullGrids = seamlessLayers.map((layer) => GridFactory.create(layer.domain.grid, null));
			sampleValue = sampleBlendedValue(layerGrids, seamlessLayers, fullGrids, interpolation);
			sampleVector = sampleBlendedVector(layerGrids, seamlessLayers, fullGrids, interpolation);
			gridSources = seamlessLayers.map((layer, i) => ({
				grid: layerGrids[i],
				values: layer.data.values ?? new Float32Array(0),
				directions: layer.data.directions
			}));
		} else {
			const grid = GridFactory.create((domain as Domain).grid, ranges);
			const vectorValues = values ?? new Float32Array(0);
			sampleValue = (lat, lon) => grid.getInterpolatedValue(vectorValues, lat, lon, interpolation);
			// Sample the magnitude with the selected method so arrow size/colour
			// matches the raster; direction stays linear (averaging angles would be wrong).
			sampleVector = (lat, lon) => ({
				value: grid.getInterpolatedValue(vectorValues, lat, lon, interpolation),
				direction: directions ? grid.getLinearInterpolatedValue(directions, lat, lon) : 0
			});
			gridSources = [{ grid, values: vectorValues, directions }];
		}

		if (renderOptions.drawGrid) {
			generateGridPoints(pbf, gridSources, x, y, z, clippingOptions);
		}
		if (renderOptions.drawArrows && directions) {
			generateArrows(pbf, sampleVector, x, y, z, clippingOptions);
		}
		if (renderOptions.drawContours) {
			generateContours(
				pbf,
				sampleValue,
				x,
				y,
				z,
				tileSize,
				renderOptions.intervals,
				clippingOptions,
				computeHalfQuantum(message.data.data.scaleFactor)
			);
		}

		const arrayBuffer = pbf.finish();
		postMessage(
			{ type: 'returnArrayBuffer', tile: arrayBuffer.buffer, key: key },
			{ transfer: [arrayBuffer.buffer] }
		);
	}
};
