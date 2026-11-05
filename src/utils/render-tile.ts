import { PbfWriter } from 'pbf';

import { generateArrows } from './arrows';
import { checkAgainstBounds } from './bounds';
import { type ResolvedClippingOptions } from './clipping';
import { generateContours } from './contours';
import { generateGridPoints } from './grid-points';
import { tile2lat, tile2lon } from './math';
import { createSamplers } from './samplers';
import { makeColorSampler } from './styling';
import { generateWindBarbs } from './wind-barbs';

import type { LayerRenderData, RenderOptions, TileIndex } from '../types';

/**
 * Pure tile renderers: plain TypeScript over the layer data, with no canvas,
 * worker or DOM dependency, so the same code renders in the tile worker and
 * in Node. Polygon clipping is not part of them (it is a canvas operation);
 * bounds clipping is, since it happens per pixel.
 */

const prepareSamplers = (layers: LayerRenderData[], renderOptions: RenderOptions) => {
	// The domains the tile is rendered from, finest-first: at any point the
	// finest one with data there wins. A plain request has a single layer.
	if (!layers.some((layer) => layer.data.values)) {
		throw new Error('No values provided');
	}
	return createSamplers(layers, renderOptions.interpolation);
};

/** Renders the raster tile as straight-alpha RGBA, `tileSize` × `tileSize` pixels. */
export const renderRasterTile = (
	layers: LayerRenderData[],
	tileIndex: TileIndex,
	renderOptions: RenderOptions,
	clippingOptions: ResolvedClippingOptions | undefined
): Uint8ClampedArray<ArrayBuffer> => {
	const { z, x, y } = tileIndex;
	const { tileSize, colorBlend, colorScale } = renderOptions;
	const { sampleThresholdValue } = prepareSamplers(layers, renderOptions);

	const pixels = tileSize * tileSize;
	// Initialized with zeros
	const rgba = new Uint8ClampedArray(pixels * 4);

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
				if (checkAgainstBounds(lon, clippingOptions.bounds[0], clippingOptions.bounds[2])) continue;

			// Threshold-offset sample, so colour band edges stay off the
			// quantization grid (see `sampleThresholdValue`).
			const px = sampleThresholdValue(lat, lon);

			if (isFinite(px)) {
				const color = sampleColor(px, colorOut);
				rgba[4 * ind] = color[0];
				rgba[4 * ind + 1] = color[1];
				rgba[4 * ind + 2] = color[2];
				rgba[4 * ind + 3] = 255 * color[3];
			}
		}
	}

	return rgba;
};

/** Renders the vector tile (grid points, arrows or barbs, contours) as PBF bytes. */
export const renderVectorTile = (
	layers: LayerRenderData[],
	tileIndex: TileIndex,
	renderOptions: RenderOptions,
	clippingOptions: ResolvedClippingOptions | undefined
): Uint8Array => {
	const { z, x, y } = tileIndex;
	const { tileSize } = renderOptions;
	const { sampleThresholdValue, sampleVector, gridSources } = prepareSamplers(
		layers,
		renderOptions
	);

	// Directions come from the variable's derivation rule, which is the same
	// for every layer of a request, so one layer tells.
	const hasDirections = layers[0].data.directions !== undefined;

	const pbf = new PbfWriter();

	if (renderOptions.drawGrid) {
		generateGridPoints(pbf, gridSources, x, y, z, clippingOptions);
	}
	if (renderOptions.drawArrows && hasDirections) {
		const draw = renderOptions.arrowStyle === 'barb' ? generateWindBarbs : generateArrows;
		draw(pbf, sampleVector, x, y, z, clippingOptions);
	}
	if (renderOptions.drawContours) {
		// Same threshold-offset sample as the raster, so contours align with
		// the colour band edges.
		generateContours(
			pbf,
			sampleThresholdValue,
			x,
			y,
			z,
			tileSize,
			renderOptions.intervals,
			clippingOptions
		);
	}

	return pbf.finish();
};
