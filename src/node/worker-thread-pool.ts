/**
 * Renders tiles on a pool of `worker_threads`, so a rendering server keeps
 * its event loop free while tiles draw. The Node counterpart of the browser's
 * `WorkerPool`: tiles go round-robin to the threads, data windows in
 * SharedArrayBuffers are shared with them, anything else is structured-cloned
 * per request.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

import type { ThreadRequest, ThreadResponse } from './tile-worker';

import type { TilePromise, TileRenderer, TileRequest, TileResult } from '../types';

export interface WorkerThreadPoolOptions {
	/** Number of render threads. @default min(8, availableParallelism()) */
	size?: number;
	/**
	 * The thread's script. @default the `node-worker.mjs` shipped next to the
	 * Node entry
	 */
	workerUrl?: URL;
}

interface Pending {
	resolve: (result: TileResult) => void;
	reject: (error: Error) => void;
	worker: Worker;
}

export class WorkerThreadPool implements TileRenderer {
	private readonly size: number;
	private readonly workerUrl: URL;
	private workers: Worker[] = [];
	private nextWorker = 0;
	private nextId = 0;
	private readonly pending = new Map<number, Pending>();

	constructor(options: WorkerThreadPoolOptions = {}) {
		// Beyond ~8 threads tile rendering is bandwidth-bound, as in the browser
		this.size = options.size ?? Math.min(8, availableParallelism());
		this.workerUrl = options.workerUrl ?? new URL('./node-worker.mjs', import.meta.url);
	}

	/**
	 * The threads start with the first tile, not with the import, so a process
	 * that only reads metadata never spawns them. Idle threads are unreferenced:
	 * they keep the process alive only while a tile is pending.
	 */
	private ensureWorkers(): void {
		if (this.workers.length > 0) return;
		for (let i = 0; i < this.size; i++) {
			this.workers.push(this.spawn());
		}
	}

	private spawn(): Worker {
		const worker = new Worker(this.workerUrl);
		worker.on('message', (response: ThreadResponse) => this.handleResponse(response));
		worker.on('error', (error: Error) => this.handleError(worker, error));
		worker.unref();
		return worker;
	}

	private handleResponse(response: ThreadResponse): void {
		const pending = this.pending.get(response.id);
		if (!pending) return;
		this.settle(response.id);
		if (response.error !== undefined || !response.result) {
			pending.reject(new Error(response.error ?? 'Render thread returned no result'));
		} else {
			pending.resolve(response.result);
		}
	}

	/**
	 * An uncaught exception ends the thread: its pending tiles fail visibly and
	 * a fresh thread takes its slot.
	 */
	private handleError(worker: Worker, error: Error): void {
		for (const [id, pending] of this.pending) {
			if (pending.worker !== worker) continue;
			this.settle(id);
			pending.reject(new Error(`Render thread failed: ${error.message}`));
		}
		const index = this.workers.indexOf(worker);
		if (index !== -1) this.workers[index] = this.spawn();
	}

	private settle(id: number): void {
		this.pending.delete(id);
		if (this.pending.size === 0) {
			for (const worker of this.workers) worker.unref();
		}
	}

	public requestTile(request: TileRequest): TilePromise {
		if (request.signal?.aborted) {
			return Promise.resolve({ cancelled: true });
		}
		this.ensureWorkers();
		const worker = this.workers[this.nextWorker];
		this.nextWorker = (this.nextWorker + 1) % this.workers.length;

		const id = this.nextId++;
		// The signal cannot be cloned; a tile under way is rendered to the end
		const { signal: _signal, ...rest } = request;
		const message: ThreadRequest = { id, request: rest };

		return new Promise<TileResult>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, worker });
			worker.ref();
			worker.postMessage(message);
		});
	}

	/** Ends the threads. Pending tiles are rejected. */
	public async terminate(): Promise<void> {
		const workers = this.workers;
		this.workers = [];
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			pending.reject(new Error('Render thread pool terminated'));
		}
		await Promise.all(workers.map((worker) => worker.terminate()));
	}
}
