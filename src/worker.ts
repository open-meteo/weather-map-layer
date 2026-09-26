import { PbfWriter } from 'pbf';

import { generateArrows } from './utils/arrows';
import { checkAgainstBounds } from './utils/bounds';
import { clipRasterToPolygons } from './utils/clipping';
import { generateContours } from './utils/contours';
import { generateGridPoints } from './utils/grid-points';
import { halfQuantum as computeHalfQuantum, tile2lat, tile2lon } from './utils/math';
import { createSamplers } from './utils/samplers';
import { makeColorSampler } from './utils/styling';
import { generateWindBarbs } from './utils/wind-barbs';

import type { LayerRenderData, WorkerRequest } from './types';

self.onmessage = async (message: MessageEvent<WorkerRequest>): Promise<void> => {
	const key = message.data.key;

	// Handle cancellation messages
	if (message.data.type === 'cancel') {
		postMessage({ type: 'cancelled', key });
		return;
	}

	const { z, x, y } = message.data.tileIndex;
	const { tileSize, interpolation, colorBlend, colorScale } = message.data.renderOptions;
	const clippingOptions = message.data.clippingOptions;

	// A plain request renders its single domain; a seamless one its active
	// sub-domains, finest-first. Both go through the same samplers.
	const layers: LayerRenderData[] = message.data.seamlessLayers ?? [
		{
			domain: message.data.dataOptions.domain,
			data: message.data.data,
			ranges: message.data.ranges
		}
	];
	if (!layers.some((layer) => layer.data.values)) {
		throw new Error('No values provided');
	}
	const { sampleValue, sampleVector, gridSources } = createSamplers(layers, interpolation);

	if (message.data.type == 'getImage') {
		const pixels = tileSize * tileSize;
		// Initialized with zeros
		const rgba = new Uint8ClampedArray(pixels * 4);

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

				const px = sampleValue(lat, lon);

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

		if (renderOptions.drawGrid) {
			generateGridPoints(pbf, gridSources, x, y, z, clippingOptions);
		}
		if (renderOptions.drawArrows && directions) {
			const draw = renderOptions.arrowStyle === 'barb' ? generateWindBarbs : generateArrows;
			draw(pbf, sampleVector, x, y, z, clippingOptions);
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
