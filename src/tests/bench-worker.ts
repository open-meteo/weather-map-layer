// Benchmark-only tile worker running in a node:worker_threads thread. It
// mirrors src/worker.ts — fresh grid per tile message, values arriving via
// postMessage (structured clone for plain buffers, zero-copy for
// SharedArrayBuffer-backed ones). The 'raster' mode is the getImage pixel loop
// minus the OffscreenCanvas step (which Node lacks and which costs the same
// for every method); 'contours' and 'arrows' are the getArrayBuffer vector
// paths. Spawned by interpolations.bench.ts through a tsx bootstrap so the
// TypeScript sources load outside vitest's transformer.
import { GridFactory } from '../grids/index';
import { generateArrows } from '../utils/arrows';
import { generateContours } from '../utils/contours';
import { tile2lat, tile2lon } from '../utils/math';
import { parentPort } from 'node:worker_threads';
import { PbfWriter } from 'pbf';

import type { GridData, InterpolationMethod } from '../types';

export interface BenchRenderJob {
	type: 'renderTile';
	id: number;
	mode: 'raster' | 'contours' | 'arrows';
	grid: GridData;
	values: Float32Array;
	// required for 'arrows'
	directions?: Float32Array;
	// required for 'contours'
	intervals?: number[];
	method: InterpolationMethod;
	x: number;
	y: number;
	z: number;
	tileSize: number;
}

export type BenchResponse = { id: number };

const renderRaster = (job: BenchRenderJob): void => {
	const { values, tileSize, x, y, z, method } = job;
	const grid = GridFactory.create(job.grid, null);

	// Same shape as the production pixel loop: per-column longitudes resolved
	// once, per-pixel sampling, rgba written (with a trivial ramp instead of the
	// colour scale — identical work for every method).
	const rgba = new Uint8ClampedArray(tileSize * tileSize * 4);
	const lons = new Float64Array(tileSize);
	for (let j = 0; j < tileSize; j++) {
		lons[j] = tile2lon(x + (j + 0.5) / tileSize, z);
	}
	for (let i = 0; i < tileSize; i++) {
		const lat = tile2lat(y + (i + 0.5) / tileSize, z);
		for (let j = 0; j < tileSize; j++) {
			const v = grid.getInterpolatedValue(values, lat, lons[j], method);
			if (isFinite(v)) {
				const ind = 4 * (j + i * tileSize);
				rgba[ind] = v * 8;
				rgba[ind + 3] = 255;
			}
		}
	}
};

const renderVector = (job: BenchRenderJob): void => {
	const grid = GridFactory.create(job.grid, null);

	const pbf = new PbfWriter();
	if (job.mode === 'contours') {
		const sampleValue = (lat: number, lon: number) =>
			grid.getInterpolatedValue(job.values, lat, lon, job.method);
		generateContours(
			pbf,
			sampleValue,
			job.x,
			job.y,
			job.z,
			job.tileSize,
			job.intervals ?? [],
			undefined
		);
	} else {
		// Same sampler shape as src/worker.ts: magnitude with the selected
		// method, direction linear.
		const sampleVector = (lat: number, lon: number) => ({
			value: grid.getInterpolatedValue(job.values, lat, lon, job.method),
			direction: grid.getLinearInterpolatedValue(job.directions!, lat, lon)
		});
		generateArrows(pbf, sampleVector, job.x, job.y, job.z, undefined);
	}
	pbf.finish();
};

parentPort!.on('message', (job: BenchRenderJob) => {
	if (job.mode === 'raster') {
		renderRaster(job);
	} else {
		renderVector(job);
	}
	parentPort!.postMessage({ id: job.id } satisfies BenchResponse);
});

// Signal readiness so the pool only starts timing once every thread has booted.
parentPort!.postMessage({ id: -1 } satisfies BenchResponse);
