import { clipRasterToPolygons } from './utils/clipping';
import { renderRasterTile, renderVectorTile } from './utils/render-tile';

import type { WorkerRequest } from './types';

self.onmessage = async (message: MessageEvent<WorkerRequest>): Promise<void> => {
	const key = message.data.key;

	// Handle cancellation messages
	if (message.data.type === 'cancel') {
		postMessage({ type: 'cancelled', key });
		return;
	}

	const { tileIndex, layers, renderOptions, clippingOptions } = message.data;
	const { z, x, y } = tileIndex;
	const { tileSize } = renderOptions;

	if (message.data.type == 'getImage') {
		const rgba = renderRasterTile(layers, tileIndex, renderOptions, clippingOptions);

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
		const arrayBuffer = renderVectorTile(layers, tileIndex, renderOptions, clippingOptions);
		postMessage(
			{ type: 'returnArrayBuffer', tile: arrayBuffer.buffer, key: key },
			{ transfer: [arrayBuffer.buffer] }
		);
	}
};
