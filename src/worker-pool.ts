// @ts-expect-error worker import
import TileWorker from './worker?worker&inline';

import { TilePromise, TileRequest, TileResult, TileTiming, WorkerResponse } from './types';

/**
 * Upper bound on the number of tile workers. Tile rendering is bursty; beyond
 * ~8 workers the extra parallelism is eaten by memory traffic and worker
 * startup, especially on high-core-count desktops.
 */
const MAX_WORKERS = 8;

/** How many completed tiles to aggregate into one benchmark summary line. */
const BENCH_SUMMARY_EVERY = 25;

let benchmarkEnabled =
	typeof location !== 'undefined' && /[?&#]wml-bench/.test(location.search + location.hash);

/**
 * Enable/disable per-tile benchmark logging (`[wml-bench]` console lines).
 * Also auto-enabled when the page URL contains `wml-bench` in its query or hash.
 */
export const setTileBenchmark = (enabled: boolean): void => {
	benchmarkEnabled = enabled;
};

interface PendingRequest {
	resolvers: Array<(tile: TileResult) => void>;
	request: TileRequest;
	/** Index of the worker rendering this request, or null while still queued. */
	workerIndex: number | null;
	enqueuedAt: number;
	dispatchedAt: number;
}

interface BenchAggregate {
	tiles: number;
	queue: number;
	worker: number;
	queueMax: number;
	workerMax: number;
	stages: Record<string, number>;
}

const emptyAggregate = (): BenchAggregate => ({
	tiles: 0,
	queue: 0,
	worker: 0,
	queueMax: 0,
	workerMax: 0,
	stages: {}
});

export class WorkerPool {
	private workers: Worker[] = [];
	/** Key currently being rendered by each worker, or null when idle. */
	private busyKey: (string | null)[] = [];
	/**
	 * Keys waiting for a free worker, in request order. Entries whose key is no
	 * longer in `pendingRequests` (aborted while queued) are skipped on dispatch,
	 * so aborted tiles never reach a worker at all.
	 */
	private queue: string[] = [];
	/** Stores pending tile requests by key to avoid duplicate requests for the same tile */
	private pendingRequests = new Map<string, PendingRequest>();

	private bench: BenchAggregate = emptyAggregate();

	constructor() {
		if (typeof window === 'undefined' || typeof Worker === 'undefined') {
			// Not in browser, don't create workers
			return;
		}
		const workerCount = Math.min(navigator.hardwareConcurrency || 4, MAX_WORKERS);
		for (let i = 0; i < workerCount; i++) {
			const worker = new TileWorker();
			worker.onmessage = (message: MessageEvent) => this.handleMessage(i, message);
			worker.onerror = (error: ErrorEvent) => this.handleError(i, error);
			this.workers.push(worker);
			this.busyKey.push(null);
		}
	}

	private handleMessage(workerIndex: number, message: MessageEvent): void {
		const data = message.data as WorkerResponse;

		// The worker finished its current task — free it regardless of whether
		// anyone is still interested in the result.
		if (this.busyKey[workerIndex] === data.key) {
			this.busyKey[workerIndex] = null;
		}

		const pending = this.pendingRequests.get(data.key);

		if (pending && data.type.startsWith('return')) {
			if (benchmarkEnabled) {
				this.logBenchmark(pending, data.timing);
			}

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

		this.dispatchNext();
	}

	private handleError(workerIndex: number, error: ErrorEvent): void {
		console.error('Error in worker:', error.message, error);

		// A worker that threw never posts a result for its current task, so
		// resolve that task as cancelled and free the worker — otherwise the
		// slot (and all subscribers) would hang forever.
		const key = this.busyKey[workerIndex];
		if (key !== null) {
			this.busyKey[workerIndex] = null;
			const pending = this.pendingRequests.get(key);
			if (pending) {
				pending.resolvers.forEach((resolve) => resolve({ cancelled: true }));
				this.pendingRequests.delete(key);
			}
		}
		this.dispatchNext();
	}

	/** Sends queued requests to idle workers (one in-flight task per worker). */
	private dispatchNext(): void {
		while (this.queue.length > 0) {
			const workerIndex = this.busyKey.indexOf(null);
			if (workerIndex === -1) return;

			const key = this.queue.shift()!;
			const pending = this.pendingRequests.get(key);
			// Skip entries that were aborted while queued
			if (!pending || pending.workerIndex !== null) continue;

			pending.workerIndex = workerIndex;
			pending.dispatchedAt = performance.now();
			this.busyKey[workerIndex] = key;

			// Don't send the signal object to the worker (it's not transferable)
			const { signal: _signal, ...requestWithoutSignal } = pending.request;
			this.workers[workerIndex].postMessage(requestWithoutSignal);
		}
	}

	public requestTile(request: TileRequest): TilePromise {
		if (request.signal?.aborted) {
			return Promise.resolve({ cancelled: true });
		}

		if (this.workers.length === 0) {
			return Promise.reject(new Error('No workers available (likely running in SSR)'));
		}

		const key = request.key;
		let pending = this.pendingRequests.get(key);

		if (!pending) {
			pending = {
				resolvers: [],
				request,
				workerIndex: null,
				enqueuedAt: performance.now(),
				dispatchedAt: 0
			};
			this.pendingRequests.set(key, pending);
			this.queue.push(key);
			this.dispatchNext();
		}

		const subscribed = pending;

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

				// Last subscriber gone: if the request is still queued it is simply
				// dropped (dispatchNext skips it) and never costs any worker time.
				// If it is already rendering, the eventual result is discarded and
				// the worker is freed via the busyKey match in handleMessage.
				if (p.resolvers.length === 0) {
					this.pendingRequests.delete(key);
				}
			};

			const resolver = (result: TileResult) => {
				if (request.signal) {
					request.signal.removeEventListener('abort', abortHandler);
				}
				resolve(result);
			};

			subscribed.resolvers.push(resolver);

			if (request.signal) {
				request.signal.addEventListener('abort', abortHandler, { once: true });
			}
		});
	}

	private logBenchmark(pending: PendingRequest, timing: TileTiming | undefined): void {
		const now = performance.now();
		const queueMs = pending.dispatchedAt - pending.enqueuedAt;
		const workerMs = now - pending.dispatchedAt;

		const { tileIndex, type } = pending.request;
		const stages = timing
			? Object.entries(timing)
					.filter(([stage]) => stage !== 'total')
					.map(([stage, ms]) => `${stage} ${ms.toFixed(1)}`)
					.join(', ')
			: '';
		console.log(
			`[wml-bench] ${type} ${tileIndex.z}/${tileIndex.x}/${tileIndex.y} ` +
				`queue ${queueMs.toFixed(1)}ms | worker ${workerMs.toFixed(1)}ms` +
				(stages ? ` (${stages})` : '') +
				` | total ${(now - pending.enqueuedAt).toFixed(1)}ms`
		);

		const b = this.bench;
		b.tiles++;
		b.queue += queueMs;
		b.worker += workerMs;
		b.queueMax = Math.max(b.queueMax, queueMs);
		b.workerMax = Math.max(b.workerMax, workerMs);
		if (timing) {
			for (const [stage, ms] of Object.entries(timing)) {
				b.stages[stage] = (b.stages[stage] ?? 0) + ms;
			}
		}

		if (b.tiles >= BENCH_SUMMARY_EVERY) {
			const stageSummary = Object.entries(b.stages)
				.map(([stage, ms]) => `${stage} avg ${(ms / b.tiles).toFixed(1)}`)
				.join(' | ');
			console.log(
				`[wml-bench] === summary (${b.tiles} tiles): ` +
					`queue avg ${(b.queue / b.tiles).toFixed(1)}ms max ${b.queueMax.toFixed(1)}ms | ` +
					`worker avg ${(b.worker / b.tiles).toFixed(1)}ms max ${b.workerMax.toFixed(1)}ms` +
					(stageSummary ? ` | ${stageSummary}` : '')
			);
			this.bench = emptyAggregate();
		}
	}
}
