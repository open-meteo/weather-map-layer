import Pbf from 'pbf';

import { generateArrows } from './utils/arrows';
import { checkAgainstBounds } from './utils/bounds';
import { clipRasterToPolygons } from './utils/clipping';
import { generateContours } from './utils/contours';
import { generateGridPoints } from './utils/grid-points';
import { tile2lat, tile2lon } from './utils/math';
import { getColor } from './utils/styling';

import { GridFactory } from './grids/index';
import type { GridInterface } from './grids/interface';

import type { SeamlessLayerRenderData, TileRequest } from './types';

/**
 * Recursively samples and blends values from seamless domain layers.
 * Layers are ordered finest-first.  For each layer:
 *  - If the point is outside (NaN), skip to the next coarser layer.
 *  - If fully inside the blend zone, return the value directly.
 *  - If in the transition zone, smooth-step blend with the fallback value from
 *    remaining layers.
 */
function blendFromLayer(
	layerGrids: GridInterface[],
	seamlessLayers: SeamlessLayerRenderData[],
	lat: number,
	lon: number,
	startIdx: number
): number {
	for (let i = startIdx; i < seamlessLayers.length; i++) {
		const layer = seamlessLayers[i];
		const grid = layerGrids[i];
		const vals = layer.data.values;
		if (!vals) continue;

		const value = grid.getLinearInterpolatedValue(vals, lat, lon);
		if (!isFinite(value)) continue; // point not covered by this domain

		// Last layer or no blending requested – use directly
		if (i === seamlessLayers.length - 1 || layer.blendWidthDeg <= 0) {
			return value;
		}

		// Distance from this pixel to the nearest domain edge (in degrees),
		// normalised by the blend width so 1 = fully inside, 0 = on the edge.
		const b = layer.domainBounds; // [lonMin, latMin, lonMax, latMax]
		const dWest = (lon - b[0]) / layer.blendWidthDeg;
		const dEast = (b[2] - lon) / layer.blendWidthDeg;
		const dSouth = (lat - b[1]) / layer.blendWidthDeg;
		const dNorth = (b[3] - lat) / layer.blendWidthDeg;
		const d = Math.min(dWest, dEast, dSouth, dNorth);

		if (d >= 1) return value; // completely inside blend zone

		// In the blend transition region – get a fallback from the next layer(s)
		const fallback = blendFromLayer(layerGrids, seamlessLayers, lat, lon, i + 1);
		if (!isFinite(fallback)) return value;

		// Smooth-step: t = 3d² - 2d³
		const t = d * d * (3 - 2 * d);
		return value * t + fallback * (1 - t);
	}
	return NaN;
}

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
	const colorScale = message.data.renderOptions.colorScale;
	const clippingOptions = message.data.clippingOptions;
	const seamlessLayers = message.data.seamlessLayers;

	// For non-seamless requests, values must be present
	if (!values && !(seamlessLayers && seamlessLayers.length > 0)) {
		throw new Error('No values provided');
	}

	if (message.data.type == 'getImage') {
		const pixels = tileSize * tileSize;
		// Initialized with zeros
		const rgba = new Uint8ClampedArray(pixels * 4);

		// Build the per-pixel value sampler
		let getPixelValue: (lat: number, lon: number) => number;
		if (seamlessLayers && seamlessLayers.length > 0) {
			// Pre-create all layer grids once (outside the pixel loop for efficiency)
			const layerGrids = seamlessLayers.map((layer) =>
				GridFactory.create(layer.domain.grid, layer.ranges)
			);
			getPixelValue = (lat, lon) =>
				blendFromLayer(layerGrids, seamlessLayers, lat, lon, 0);
		} else {
			const grid = GridFactory.create((domain as import('./types').Domain).grid, ranges);
			getPixelValue = (lat, lon) => grid.getLinearInterpolatedValue(values!, lat, lon);
		}

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

				const px = getPixelValue(lat, lon);

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

		let imageBitmap;
		if (clippingOptions?.polygons) {
			imageBitmap = clipRasterToPolygons(canvas, tileSize, z, x, y, clippingOptions);
		} else {
			imageBitmap = canvas.transferToImageBitmap();
		}

		postMessage({ type: 'returnImage', tile: imageBitmap, key: key }, { transfer: [imageBitmap] });
	} else if (message.data.type == 'getArrayBuffer') {
		const directions = message.data.data.directions;

		const pbf = new Pbf();

		// For seamless domains, use the finest available layer's data for vector output
		const vectorGrid =
			seamlessLayers && seamlessLayers.length > 0
				? GridFactory.create(seamlessLayers[0].domain.grid, seamlessLayers[0].ranges)
				: GridFactory.create((domain as import('./types').Domain).grid, ranges);
		const vectorValues =
			(seamlessLayers && seamlessLayers.length > 0
				? seamlessLayers[0].data.values
				: values) ?? new Float32Array(0);

		if (message.data.renderOptions.drawGrid) {
			generateGridPoints(pbf, vectorGrid, vectorValues, directions, x, y, z, clippingOptions);
		}
		if (message.data.renderOptions.drawArrows && directions) {
			generateArrows(pbf, vectorValues, directions, vectorGrid, x, y, z, clippingOptions);
		}
		if (message.data.renderOptions.drawContours) {
			const intervals = message.data.renderOptions.intervals;
			generateContours(pbf, vectorValues, vectorGrid, x, y, z, tileSize, intervals, clippingOptions);
		}

		const arrayBuffer = pbf.finish();
		postMessage(
			{ type: 'returnArrayBuffer', tile: arrayBuffer.buffer, key: key },
			{ transfer: [arrayBuffer.buffer] }
		);
	}
};
