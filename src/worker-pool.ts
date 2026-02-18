// @ts-expect-error worker import
import TileWorker from './worker?worker&inline';

import { TilePromise, TileRequest, TileResult, WorkerResponse } from './types';

export class WorkerPool {
	private workers: Worker[] = [];
	private nextWorker = 0;
	/** Stores pending tile requests by key to avoid duplicate requests for the same tile */
	private pendingRequests = new Map<
		string,
		{
			resolvers: Array<(tile: TileResult) => void>;
			worker: Worker;
		}
	>();

	constructor() {
		if (typeof window === 'undefined' || typeof Worker === 'undefined') {
			// Not in browser, don't create workers
			return;
		}
		const workerCount = navigator.hardwareConcurrency || 4;
		for (let i = 0; i < workerCount; i++) {
			const worker = new TileWorker();
			worker.onmessage = (message: MessageEvent) => this.handleMessage(message);
			worker.onerror = (error: ErrorEvent) => this.handleError(error);
			this.workers.push(worker);
		}
	}

	private handleMessage(message: MessageEvent): void {
		const data = message.data as WorkerResponse;
		const pending = this.pendingRequests.get(data.key);

		if (!pending) return;

		if (data.type === 'cancelled') {
			pending.resolvers.forEach((resolve) => resolve({ cancelled: true }));
			this.pendingRequests.delete(data.key);
			return;
		}

		if (data.type.startsWith('return')) {
			const originalTile = data.tile;
			const resolvers = pending.resolvers;

			if (resolvers.length > 0) {
				// The first subscriber can receive the original (transferred) buffer.
				const firstResolver = resolvers.shift()!;
				firstResolver({ data: originalTile, cancelled: false });

				// All other subscribers must receive a clone.
				resolvers.forEach((resolve) => {
					// Create a copy for each subsequent subscriber.
					// ImageBitmaps are safe to share without cloning.
					// FIXES: DOMException: Worker.postMessage: attempting to access detached ArrayBuffer
					const tile = originalTile instanceof ArrayBuffer ? originalTile.slice(0) : originalTile;
					resolve({ data: tile, cancelled: false });
				});
			}
			this.pendingRequests.delete(data.key);
		}
	}

	private handleError(error: ErrorEvent): void {
		// Simplified error handler: just log for now
		console.error('Error in worker:', error.message, error);
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
				resolvers: [],
				worker
			};
			this.pendingRequests.set(key, pending);

			// Don't send the signal object to the worker (it's not transferable)
			const { signal: _signal, ...requestWithoutSignal } = request;
			worker.postMessage(requestWithoutSignal);
		}

		return new Promise<TileResult>((resolve) => {
			const abortHandler = () => {
				const p = this.pendingRequests.get(key);
				if (!p) return;

				// Remove this resolver
				const idx = p.resolvers.indexOf(resolver);
				if (idx !== -1) {
					p.resolvers.splice(idx, 1);
				}

				// Resolve this specific promise as cancelled
				resolve({ cancelled: true });

				// If no more subscribers, cancel the worker task
				if (p.resolvers.length === 0) {
					p.worker.postMessage({ type: 'cancel', key });
					this.pendingRequests.delete(key);
				}
			};

			const resolver = (result: TileResult) => {
				if (request.signal) {
					request.signal.removeEventListener('abort', abortHandler);
				}
				resolve(result);
			};

			pending.resolvers.push(resolver);

			if (request.signal) {
				request.signal.addEventListener('abort', abortHandler, { once: true });
			}
		});
	}
}
