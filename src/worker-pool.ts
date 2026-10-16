import { setPackageAssets } from './assets';
import iconWarpR3Url from './grids/icon/icon-warp-r3.bin?url';
// @ts-expect-error worker import
import tileWorkerUrl from './worker?worker&url';

import {
	PackageAssets,
	TilePromise,
	TileRequest,
	TileResult,
	WorkerBufferRequest,
	WorkerInitRequest,
	WorkerResponse
} from './types';

// Resolved like the worker URL below: relative to this module, so the assets
// are found next to it in node_modules or on a CDN, and rewritten by bundlers
// that consume the package to wherever they copy the files.
const packageAssets: PackageAssets = {
	iconWarpTables: { 3: new URL(iconWarpR3Url, import.meta.url).href }
};
setPackageAssets(packageAssets);

/**
 * The tile worker ships as its own file next to the module, so it is cached
 * and parsed like any other script instead of being embedded in the bundle.
 * A worker script must be same-origin: when the library itself is loaded
 * cross-origin (e.g. straight from unpkg) the worker is bootstrapped from a
 * same-origin blob that imports the real script.
 */
const createTileWorker = (): Worker => {
	const url = new URL(tileWorkerUrl, import.meta.url);
	if (url.origin === self.location.origin) return new Worker(url);
	const shim = new Blob([`importScripts(${JSON.stringify(url.href)});`], {
		type: 'text/javascript'
	});
	return new Worker(URL.createObjectURL(shim));
};

export class WorkerPool {
	private workers: Worker[] = [];
	private nextWorker = 0;
	private readonly sharedKeys = new Set<string>();
	/** Stores pending tile requests by key to avoid duplicate requests for the same tile */
	private pendingRequests = new Map<
		string,
		{
			subscribers: Array<{ resolve: (tile: TileResult) => void; reject: (error: Error) => void }>;
			worker: Worker;
		}
	>();

	constructor() {
		if (typeof window === 'undefined' || typeof Worker === 'undefined') {
			// Not in browser, don't create workers
			return;
		}
		// Cap the pool: beyond ~8 workers tile rendering is bandwidth-bound, and
		// every worker holds its own copy of the tile-rendering code in memory.
		const workerCount = Math.min(8, navigator.hardwareConcurrency || 4);
		for (let i = 0; i < workerCount; i++) {
			const worker = createTileWorker();
			worker.onmessage = (message: MessageEvent) => this.handleMessage(message);
			worker.onerror = (error: ErrorEvent) => this.handleError(error);
			// Queued ahead of every tile request, so the worker knows the asset
			// URLs (which only this thread can resolve) before it needs them.
			const init: WorkerInitRequest = { type: 'init', assets: packageAssets };
			worker.postMessage(init);
			this.workers.push(worker);
		}
	}

	/**
	 * Hands a buffer to every worker once. Messages are delivered in order, so
	 * a buffer shared before a tile request is available when the tile renders.
	 */
	public share(key: string, buffer: ArrayBufferLike): void {
		if (this.sharedKeys.has(key)) return;
		this.sharedKeys.add(key);
		const message: WorkerBufferRequest = { type: 'buffer', key, buffer };
		for (const worker of this.workers) worker.postMessage(message);
	}

	private handleMessage(message: MessageEvent): void {
		const data = message.data as WorkerResponse;

		const pending = this.pendingRequests.get(data.key);

		if (!pending) return;

		if (data.type === 'cancelled') {
			pending.subscribers.forEach(({ resolve }) => resolve({ cancelled: true }));
			this.pendingRequests.delete(data.key);
			return;
		}

		if (data.type.startsWith('return')) {
			const originalTile = data.tile;
			const subscribers = pending.subscribers;

			if (subscribers.length > 0) {
				// The first subscriber can receive the original (transferred) buffer.
				const firstSubscriber = subscribers.shift()!;
				firstSubscriber.resolve({ data: originalTile, cancelled: false, renderMs: data.renderMs });

				// All other subscribers must receive a clone.
				subscribers.forEach(({ resolve }) => {
					// Create a copy for each subsequent subscriber.
					// ImageBitmaps are safe to share without cloning.
					// FIXES: DOMException: Worker.postMessage: attempting to access detached ArrayBuffer
					const tile = originalTile instanceof ArrayBuffer ? originalTile.slice(0) : originalTile;
					resolve({ data: tile, cancelled: false, renderMs: data.renderMs });
				});
			}
			this.pendingRequests.delete(data.key);
		}
	}

	private handleError(error: ErrorEvent): void {
		console.error('Error in worker:', error.message, error);
		// An uncaught worker exception carries no request key and the worker will
		// never post a response for it. Reject everything pending on that worker
		// so tiles fail visibly instead of leaving MapLibre waiting forever.
		const worker = error.target instanceof Worker ? error.target : undefined;
		for (const [key, pending] of this.pendingRequests) {
			if (worker && pending.worker !== worker) continue;
			pending.subscribers.forEach(({ reject }) =>
				reject(new Error(`Worker error while rendering tile ${key}: ${error.message}`))
			);
			this.pendingRequests.delete(key);
		}
	}

	public getNextWorker(): Worker | undefined {
		if (this.workers.length === 0) return undefined;

		const worker = this.workers[this.nextWorker];
		this.nextWorker = (this.nextWorker + 1) % this.workers.length;
		return worker;
	}

	public requestTile(request: TileRequest): TilePromise {
		if (request.signal?.aborted) {
			return Promise.resolve({ cancelled: true });
		}

		const key = request.key;
		let pending = this.pendingRequests.get(key);

		if (!pending) {
			const worker = this.getNextWorker();
			if (!worker) {
				return Promise.reject(new Error('No workers available (likely running in SSR)'));
			}

			pending = {
				subscribers: [],
				worker
			};
			this.pendingRequests.set(key, pending);

			// Don't send the signal object to the worker (it's not transferable)
			const { signal: _signal, ...requestWithoutSignal } = request;
			worker.postMessage(requestWithoutSignal);
		}

		return new Promise<TileResult>((resolve, reject) => {
			const abortHandler = () => {
				const p = this.pendingRequests.get(key);
				if (!p) return;

				// Remove this subscriber
				const idx = p.subscribers.indexOf(subscriber);
				if (idx !== -1) {
					p.subscribers.splice(idx, 1);
				}

				// Resolve this specific promise as cancelled
				resolve({ cancelled: true });

				// If no more subscribers, cancel the worker task
				if (p.subscribers.length === 0) {
					p.worker.postMessage({ type: 'cancel', key });
					this.pendingRequests.delete(key);
				}
			};

			const removeAbortHandler = () => {
				if (request.signal) {
					request.signal.removeEventListener('abort', abortHandler);
				}
			};

			const subscriber = {
				resolve: (result: TileResult) => {
					removeAbortHandler();
					resolve(result);
				},
				reject: (error: Error) => {
					removeAbortHandler();
					reject(error);
				}
			};

			pending.subscribers.push(subscriber);

			if (request.signal) {
				request.signal.addEventListener('abort', abortHandler, { once: true });
			}
		});
	}
}
