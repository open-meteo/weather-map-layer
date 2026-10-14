/**
 * Entry of the Node render threads (`dist/node-worker.mjs`). Each message is
 * one tile request from `WorkerThreadPool`, rendered with the same in-process
 * renderer a single thread would use; the answer carries the request id and
 * either the tile or the error message.
 */
import { parentPort } from 'node:worker_threads';

import { MainThreadRenderer } from './main-thread-renderer';

import type { TileRequest } from '../types';

/** A request as the pool posts it: the id to answer with, and the request without its signal. */
export interface ThreadRequest {
	id: number;
	request: TileRequest;
}

/** An answer to a `ThreadRequest`. */
export interface ThreadResponse {
	id: number;
	result?: Awaited<ReturnType<MainThreadRenderer['requestTile']>>;
	error?: string;
}

const port = parentPort;
if (!port) {
	throw new Error('tile-worker.ts must run as a worker thread');
}

const renderer = new MainThreadRenderer();

port.on('message', async ({ id, request }: ThreadRequest) => {
	try {
		const result = await renderer.requestTile(request);
		const response: ThreadResponse = { id, result };
		// The pixel or PBF buffer is handed over rather than copied
		const data = result.data;
		const transfer: ArrayBuffer[] =
			data instanceof ArrayBuffer
				? [data]
				: data && 'rgba' in data
					? [data.rgba.buffer as ArrayBuffer]
					: [];
		port.postMessage(response, transfer);
	} catch (err) {
		const response: ThreadResponse = {
			id,
			error: err instanceof Error ? err.message : String(err)
		};
		port.postMessage(response);
	}
});
