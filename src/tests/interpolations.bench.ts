import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { afterAll, bench, describe } from 'vitest';

import type { BenchRenderJob, BenchResponse } from './bench-worker';

import type { InterpolationMethod, RegularGridData } from '../types';

// Real-world workload: a complete global 0.25° grid (e.g. ncep_gfs025,
// 1440x721 ≈ 1M cells) rendered by a pool of real worker threads, the way
// production renders through its Web Worker pool. node:worker_threads has the
// same structured-clone and SharedArrayBuffer semantics as Web Workers, so the
// SAB-backed values are genuinely shared with the threads instead of copied;
// only the OffscreenCanvas step is missing (identical for every method).
const gridData: RegularGridData = {
	type: 'regular',
	nx: 1440,
	ny: 721,
	lonMin: -180,
	latMin: -90,
	dx: 0.25,
	dy: 0.25
};

// Gently-varying field quantised to 0.05 (temperature is stored at scalefactor
// 20), read straight into SharedArrayBuffers like the production file reader
// (useSAB).
const values = new Float32Array(new SharedArrayBuffer(gridData.nx * gridData.ny * 4));
const directions = new Float32Array(new SharedArrayBuffer(gridData.nx * gridData.ny * 4));
for (let j = 0; j < gridData.ny; j++) {
	for (let i = 0; i < gridData.nx; i++) {
		const v = 10 + 0.01 * i + 0.02 * j + 2 * Math.sin(i / 15) * Math.cos(j / 17);
		values[j * gridData.nx + i] = Math.round(v / 0.05) * 0.05;
		directions[j * gridData.nx + i] = (i * 13 + j * 29) % 360;
	}
}

const tileSize = 256;

// The viewport rendered by every bench: a 5x4 tile block at z5, mid-latitudes
// (lon 0..56.25°, lat 0..40.98°) — what a desktop window shows after pan/zoom
// or a timestep change. Every sample lands inside the grid, so all tiles do
// real work.
const viewportZ = 5;
const viewportTiles: Array<[x: number, y: number]> = [];
for (let y = 12; y < 16; y++) {
	for (let x = 16; x < 21; x++) {
		viewportTiles.push([x, y]);
	}
}

// The field spans ~22..32 over the viewport; intervals inside that range so
// the marching squares actually emit contours.
const contourIntervals = [22, 24, 26, 28, 30, 32];

const methods: InterpolationMethod[] = ['nearest', 'linear', 'cubic', 'monotone'];

// --- worker pool ---

// Boots the TypeScript bench worker in a plain Node thread: registers the tsx
// loader (vitest's transformer doesn't reach into worker threads), then imports
// the real module.
const tsxBootstrap = `
const { workerData } = require('node:worker_threads');
(async () => {
	const { register } = await import('tsx/esm/api');
	register();
	await import(workerData.workerPath);
})();
`;

class BenchWorkerPool {
	private workers: Worker[] = [];
	private pending = new Map<number, (response: BenchResponse) => void>();
	private nextId = 0;
	private nextWorker = 0;
	readonly ready: Promise<unknown>;

	constructor(count: number) {
		const readiness: Promise<void>[] = [];
		for (let i = 0; i < count; i++) {
			const worker = new Worker(tsxBootstrap, {
				eval: true,
				workerData: { workerPath: new URL('./bench-worker.ts', import.meta.url).href }
			});
			readiness.push(
				new Promise((resolve, reject) => {
					worker.on('error', reject);
					worker.on('message', (response: BenchResponse) => {
						if (response.id === -1) {
							resolve();
							return;
						}
						const settle = this.pending.get(response.id);
						this.pending.delete(response.id);
						settle?.(response);
					});
				})
			);
			// Don't hold the process open if afterAll doesn't run in bench mode.
			worker.unref();
			this.workers.push(worker);
		}
		this.ready = Promise.all(readiness);
	}

	run(job: Omit<BenchRenderJob, 'id'>): Promise<BenchResponse> {
		const id = this.nextId++;
		const worker = this.workers[this.nextWorker];
		this.nextWorker = (this.nextWorker + 1) % this.workers.length;
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			worker.postMessage({ ...job, id });
		});
	}

	terminate(): Promise<unknown> {
		return Promise.all(this.workers.map((worker) => worker.terminate()));
	}
}

const workerCount = availableParallelism();
const pool = new BenchWorkerPool(workerCount);
await pool.ready;
afterAll(() => pool.terminate());

// Fans one viewport out over the pool round-robin (like WorkerPool) and
// resolves when the slowest tile lands — wall-clock per viewport.
const renderViewport = (
	mode: BenchRenderJob['mode'],
	method: InterpolationMethod
): Promise<unknown> => {
	return Promise.all(
		viewportTiles.map(([x, y]) =>
			pool.run({
				type: 'renderTile',
				mode,
				grid: gridData,
				values,
				directions: mode === 'arrows' ? directions : undefined,
				intervals: mode === 'contours' ? contourIntervals : undefined,
				method,
				x,
				y,
				z: viewportZ,
				tileSize
			})
		)
	);
};

describe(`raster viewport (20 tiles @ z5, ${workerCount} threads) — global 0.25° grid`, () => {
	for (const method of methods)
		bench(method, async () => {
			await renderViewport('raster', method);
		});
});

describe(`contours viewport (20 tiles @ z5, ${workerCount} threads) — global 0.25° grid`, () => {
	for (const method of methods)
		bench(method, async () => {
			await renderViewport('contours', method);
		});
});

describe(`wind arrows viewport (20 tiles @ z5, ${workerCount} threads) — global 0.25° grid`, () => {
	for (const method of methods)
		bench(method, async () => {
			await renderViewport('arrows', method);
		});
});
