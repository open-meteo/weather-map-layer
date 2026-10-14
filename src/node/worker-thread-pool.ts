/**
 * Renders tiles on a pool of `worker_threads`, so a rendering server keeps
 * its event loop free while tiles draw. The Node counterpart of the browser's
 * `WorkerPool`: tiles go round-robin to the threads, data windows in
 * SharedArrayBuffers are shared with them, anything else is structured-cloned
 * per request. Unlike the browser pool it renders every request it is
 * handed; merging identical requests in flight is the tile server's job.
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
	/** The request's abort signal and the listener on it, removed once settled. */
	signal?: AbortSignal;
	onAbort?: () => void;
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
		const size = options.size ?? Math.min(8, availableParallelism());
		if (!Number.isInteger(size) || size < 1) {
			throw new Error(`WorkerThreadPool size must be a positive integer, got ${size}`);
		}
		this.size = size;
		this.workerUrl = options.workerUrl ?? new URL('./node-worker.mjs', import.meta.url);
	}

	/**
	 * The threads start with the first tile, not with the import, so a process
	 * that only reads metadata never spawns them. A thread that died is
	 * replaced here too, by the next request rather than on the spot, so a
	 * script that keeps crashing fails one request at a time instead of
	 * respawning in a loop. Idle threads are unreferenced: they keep the
	 * process alive only while a tile is pending.
	 */
	private ensureWorkers(): void {
		while (this.workers.length < this.size) {
			this.workers.push(this.spawn());
		}
	}

	private spawn(): Worker {
		const worker = new Worker(this.workerUrl);
		worker.on('message', (response: ThreadResponse) => this.handleResponse(response));
		worker.on('error', (error: Error) => this.handleError(worker, error));
		worker.on('exit', (code: number) => this.handleExit(worker, code));
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
	 * its slot stays empty until the next request spawns a fresh thread.
	 */
	private handleError(worker: Worker, error: Error): void {
		for (const [id, pending] of this.pending) {
			if (pending.worker !== worker) continue;
			this.settle(id);
			pending.reject(new Error(`Render thread failed: ${error.message}`));
		}
		const index = this.workers.indexOf(worker);
		if (index !== -1) this.workers.splice(index, 1);
	}

	/**
	 * A thread leaving without an error event (`process.exit` in its script)
	 * would otherwise keep its tiles pending forever. Threads the pool let go
	 * of itself (terminate, an error handled above) are no longer listed.
	 */
	private handleExit(worker: Worker, code: number): void {
		if (!this.workers.includes(worker)) return;
		this.handleError(worker, new Error(`exited with code ${code}`));
	}

	private settle(id: number): void {
		const pending = this.pending.get(id);
		if (pending?.onAbort) pending.signal?.removeEventListener('abort', pending.onAbort);
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
		this.nextWorker %= this.workers.length;
		const worker = this.workers[this.nextWorker];
		this.nextWorker = (this.nextWorker + 1) % this.workers.length;

		const id = this.nextId++;
		// The signal cannot be cloned, and a render under way cannot be
		// interrupted anyway: an abort settles the request here, like the browser
		// pool does, and the thread's late answer finds nothing pending
		const { signal, ...rest } = request;
		const message: ThreadRequest = { id, request: rest };

		return new Promise<TileResult>((resolve, reject) => {
			const onAbort = (): void => {
				if (!this.pending.has(id)) return;
				this.settle(id);
				resolve({ cancelled: true });
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			this.pending.set(id, { resolve, reject, worker, signal, onAbort });
			worker.ref();
			worker.postMessage(message);
		});
	}

	/** Ends the threads. Pending tiles are rejected. */
	public async terminate(): Promise<void> {
		const workers = this.workers;
		this.workers = [];
		for (const [id, pending] of this.pending) {
			this.settle(id);
			pending.reject(new Error('Render thread pool terminated'));
		}
		await Promise.all(workers.map((worker) => worker.terminate()));
	}
}
