// @ts-ignore
import TileWorker from './worker?worker&inline';

import type { Data } from './om-protocol';

import type { Domain, Variable, DimensionRange } from './types';

export interface TileRequest {
	type: 'GT';
	x: number;
	y: number;
	z: number;
	key: string;
	data: Data;
	domain: Domain;
	variable: Variable;
	ranges: DimensionRange[];
	dark: boolean;
	mapBounds: number[];
	northArrow: ImageDataArray;
}

export type TileResponse = {
	type: 'RT';
	tile: ImageBitmap;
	key: string;
};

export class WorkerPool {
	private workers: Worker[] = [];
	private nextWorker = 0;
	/** Stores pending tile requests by key to avoid duplicate requests for the same tile */
	private pendingTiles = new Map<string, Promise<ImageBitmap>>();

	/** Stores resolve functions for pending promises, used to fulfill promises when worker responses arrive */
	private resolvers = new Map<string, (tile: ImageBitmap) => void>();

	constructor() {
		if (typeof window === 'undefined' || typeof Worker === 'undefined') {
			// Not in browser, don't create workers
			return;
		}
		const workerCount = navigator.hardwareConcurrency || 4;
		for (let i = 0; i < workerCount; i++) {
			const worker = new TileWorker();
			worker.onmessage = (message: MessageEvent) => this.handleMessage(message);
			this.workers.push(worker);
		}
	}

	private handleMessage(message: MessageEvent): void {
		const data = message.data as TileResponse;
		if (data.type === 'RT') {
			const resolve = this.resolvers.get(data.key);
			if (resolve) {
				resolve(data.tile);
				this.resolvers.delete(data.key);
				this.pendingTiles.delete(data.key);
			} else {
				console.error(`Unexpected tile response for ${data.key}`);
			}
		}
	}

	public getNextWorker(): Worker | undefined {
		if (this.workers.length === 0) return undefined;

		const worker = this.workers[this.nextWorker];
		this.nextWorker = (this.nextWorker + 1) % this.workers.length;
		return worker;
	}

	public requestTile(request: TileRequest): Promise<ImageBitmap> {
		const existingPromise = this.pendingTiles.get(request.key);
		if (existingPromise) {
			return existingPromise;
		}

		const worker = this.getNextWorker();
		if (!worker) {
			return Promise.reject(new Error('No workers available (likely running in SSR)'));
		}

		const promise = new Promise<ImageBitmap>((resolve) => {
			this.resolvers.set(request.key, resolve);
		});

		this.pendingTiles.set(request.key, promise);
		worker.postMessage(request);

		return promise;
	}
}
