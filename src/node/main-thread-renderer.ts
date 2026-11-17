import { renderRasterTile, renderVectorTile } from '../utils/render-tile';

import type { TilePromise, TileRenderer, TileRequest } from '../types';

/**
 * Renders tiles on the calling thread, for Node where there is no web worker
 * pool and no canvas. Raster tiles come back as plain RGBA pixels instead of
 * an `ImageBitmap`; encode them with `encodePng` to serve them.
 */
export class MainThreadRenderer implements TileRenderer {
	public async requestTile(request: TileRequest): TilePromise {
		if (request.signal?.aborted || request.type === 'cancel') {
			return { cancelled: true };
		}
		const { layers, tileIndex, renderOptions, clippingOptions } = request;

		if (request.type === 'getImage') {
			// Polygon clipping is a canvas clip path in the worker; the pixel loop
			// only knows bounds clipping.
			if (clippingOptions?.polygons) {
				throw new Error('Polygon clipping is not supported by the Node renderer yet');
			}
			const rgba = renderRasterTile(layers, tileIndex, renderOptions, clippingOptions);
			const { tileSize } = renderOptions;
			return { data: { width: tileSize, height: tileSize, rgba }, cancelled: false };
		}

		const bytes = renderVectorTile(layers, tileIndex, renderOptions, clippingOptions);
		// The PBF writer over-allocates; hand out a buffer of exactly the written bytes.
		return { data: bytes.slice().buffer, cancelled: false };
	}
}
