/**
 * Worker side of the GPU tile path: takes GPU-flagged raster requests off
 * the pixel loop and answers them through the tile queue with the same
 * `returnImage` / `cancelled` messages the CPU path posts.
 *
 * Without WebGL2 in the worker, or after any GL failure, the tiles are
 * handed back to the CPU loop: the pool learns via `gpuUnavailable` and
 * re-sends the affected tiles as plain requests.
 */
import type { GpuWorkerRequest } from './tile-pool';
import { GpuTileQueue } from './tile-queue';
import type { GpuTileSink } from './tile-queue';
import { GpuTileRenderer } from './tile-renderer';
import type { GpuTileRequest } from './tile-renderer';

let renderer: GpuTileRenderer | null | undefined; // undefined: not tried yet
let queue: GpuTileQueue | null = null;
let unavailableReported = false;

const reportUnavailable = (): void => {
	if (unavailableReported) return;
	unavailableReported = true;
	postMessage({ type: 'gpuUnavailable' });
};

const giveUp = (reason: unknown): void => {
	console.warn('GPU tile rendering unavailable, using the CPU rasteriser:', reason);
	reportUnavailable();
	const abandoned = queue?.abandon() ?? [];
	renderer?.dispose();
	renderer = null;
	queue = null;
	for (const { key, request } of abandoned) {
		postMessage({ type: 'needData', key, dataKey: request.dataKey });
	}
};

const sink: GpuTileSink = {
	done: (key, bitmap) =>
		postMessage({ type: 'returnImage', tile: bitmap, key }, { transfer: [bitmap] }),
	needData: (key, dataKey) => postMessage({ type: 'needData', key, dataKey }),
	// A shader or allocation failure is not tile-specific: hand this tile and
	// everything still queued back to the CPU loop
	failed: (key, request, error) => {
		giveUp(error);
		postMessage({ type: 'needData', key, dataKey: request.dataKey });
	}
};

const getQueue = (): GpuTileQueue | null => {
	if (renderer === undefined) {
		try {
			renderer = new GpuTileRenderer();
			queue = new GpuTileQueue(renderer, sink);
		} catch (error) {
			giveUp(error);
		}
	}
	return queue;
};

/**
 * Take over a GPU-flagged raster request. Returns false when the CPU loop
 * should render it after all (no WebGL2, values attached).
 */
export const acceptGpuTile = (request: GpuWorkerRequest): boolean => {
	if (request.type !== 'getImage' || !request.gpu || request.dataKey === undefined) return false;
	const values = request.data.values;
	const activeQueue = getQueue();
	if (!activeQueue || !renderer) {
		if (values) return false;
		// Values were stripped for the GPU cache; the pool re-sends them as a CPU request
		postMessage({ type: 'needData', key: request.key, dataKey: request.dataKey });
		return true;
	}
	if (values) renderer.setValues(request.dataKey, values);
	const gpuRequest: GpuTileRequest = {
		tileIndex: request.tileIndex,
		dataKey: request.dataKey,
		scaleFactor: request.data.scaleFactor,
		ranges: request.ranges,
		domain: request.dataOptions.domain,
		renderOptions: request.renderOptions,
		clipBounds: request.clippingOptions?.bounds
	};
	activeQueue.enqueue(request.key, gpuRequest);
	return true;
};

export const cancelGpuTile = (key: string): void => {
	queue?.cancel(key);
};
