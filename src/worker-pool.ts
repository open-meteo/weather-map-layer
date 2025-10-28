import type { Data } from './om-protocol';
// @ts-ignore
import TileWorker from './worker?worker&inline';

import type { ColorScale, DimensionRange, Domain, Variable } from './types';

export interface TileRequest {
	type: 'getArrayBuffer' | 'getImage';

	x: number;
	y: number;
	z: number;
	key: string;
	data: Data;
	dark: boolean;
	ranges: DimensionRange[];
	tileSize: number;
	interval: number;
	domain: Domain;
	variable: Variable;
	colorScale: ColorScale;
	mapBounds: number[];
}

export type TileResponse = ImageBitmap | ArrayBuffer;
export type TilePromise = Promise<TileResponse>;

export type WorkerResponse = {
	type: 'returnImage' | 'returnArrayBuffer';
	tile: TileResponse;
	key: string;
};

export class WorkerPool {
	private workers: Worker[] = [];
	private nextWorker = 0;
	/** Stores pending tile requests by key to avoid duplicate requests for the same tile */
	private pendingTiles = new Map<string, TilePromise>();

	/**
	 * Stores an array of resolve functions for each pending key.
	 * This allows for multiple subscribers for the same tile key.
	 */
	private resolvers = new Map<string, Array<(tile: TileResponse) => void>>();

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
		if (data.type.startsWith('return')) {
			const resolveFns = this.resolvers.get(data.key);

			if (resolveFns && resolveFns.length > 0) {
				const originalTile = data.tile;

				// The first subscriber can receive the original (transferred) buffer.
				const firstResolver = resolveFns.shift()!;
				firstResolver(originalTile);

				// All other subscribers must receive a clone.
				resolveFns.forEach((resolve) => {
					if (originalTile instanceof ArrayBuffer) {
						// Create a copy for each subsequent subscriber.
						resolve(originalTile.slice(0));
					} else {
						// ImageBitmaps are safe to share without cloning.
						resolve(originalTile);
					}
				});

				// Clean up now that all promises for this key are resolved.
				this.resolvers.delete(data.key);
				this.pendingTiles.delete(data.key);
			} else {
				console.error(`Unexpected tile response for ${data.key}`);
			}
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
		// If a request for this key is already in flight...
		if (this.pendingTiles.has(request.key)) {
			// ...create a new promise and add its resolver to the list for this key.
			return new Promise<TileResponse>((resolve) => {
				this.resolvers.get(request.key)!.push(resolve);
			});
		}

		// This is the first request for this key.
		const worker = this.getNextWorker();
		if (!worker) {
			return Promise.reject(new Error('No workers available (likely running in SSR)'));
		}

		// Create the promise and store its resolver in a new array.
		const promise = new Promise<TileResponse>((resolve) => {
			this.resolvers.set(request.key, [resolve]);
		});

		// Store the master promise to indicate a request is in-flight.
		this.pendingTiles.set(request.key, promise);

		worker.postMessage(request);

		return promise;
	}
}
