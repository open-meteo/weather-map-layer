import { SummedAreaTable, buildSummedAreaTable } from '../grids/area-average';
import { RegularGrid } from '../grids/regular';
import { generateArrows } from '../utils/arrows';
import { DEFAULT_SMOOTH_FOOTPRINT } from '../utils/constants';
import { generateContours } from '../utils/contours';
import { tile2lat, tile2lon } from '../utils/math';
import { PbfWriter } from 'pbf';
import { bench, describe } from 'vitest';

import type { InterpolationMethod, RegularGridData } from '../types';

// Representative workload: a ~256x256-cell data window (e.g. a dwd_icon_d2
// covering range), rendered for one z7 tile that falls fully inside it. Each
// benchmark uses a *fresh* grid, so the 'smooth' summed-area table is rebuilt
// once per tile — the production fallback path when SharedArrayBuffer is
// unavailable (the SAB path is compared separately below).
const gridData: RegularGridData = {
	type: 'regular',
	nx: 256,
	ny: 256,
	lonMin: 0,
	latMin: 0,
	dx: 0.02,
	dy: 0.02
};

// Gently-varying field quantised to 0.05 (temperature is stored at scalefactor 20).
const values = new Float32Array(gridData.nx * gridData.ny);
const directions = new Float32Array(gridData.nx * gridData.ny);
for (let j = 0; j < gridData.ny; j++) {
	for (let i = 0; i < gridData.nx; i++) {
		const v = 10 + 0.02 * i + 0.015 * j + 2 * Math.sin(i / 15) * Math.cos(j / 17);
		values[j * gridData.nx + i] = Math.round(v / 0.05) * 0.05;
		directions[j * gridData.nx + i] = (i * 13 + j * 29) % 360;
	}
}

// A z7 tile fully inside the grid (lon/lat 0..2.81°), so every sample does real work.
const tileSize = 256;
const tileZ = 7;
const tileX = 64;
const tileY = 63;
const contourIntervals = [10, 12, 14, 16, 18, 20];

const methods: InterpolationMethod[] = ['nearest', 'linear', 'cubic', 'monotone', 'smooth'];

// prevent the optimiser from discarding the work (intentionally unread)
let _sink = 0;

// Raster: getInterpolatedValue per pixel, sampled at the pixel centre like the
// worker. An injected `sat` mirrors the shared-SAT production path ('smooth'
// with SharedArrayBuffer available); without it the grid lazily builds its own.
function renderRaster(method: InterpolationMethod, sat?: SummedAreaTable): void {
	const grid = new RegularGrid(gridData);
	if (sat) {
		grid.setSummedAreaTable(sat, values);
	}
	let acc = 0;
	for (let i = 0; i < tileSize; i++) {
		const lat = tile2lat(tileY + (i + 0.5) / tileSize, tileZ);
		for (let j = 0; j < tileSize; j++) {
			const lon = tile2lon(tileX + (j + 0.5) / tileSize, tileZ);
			const v = grid.getInterpolatedValue(values, lat, lon, method, DEFAULT_SMOOTH_FOOTPRINT);
			if (isFinite(v)) acc += v;
		}
	}
	_sink += acc;
}

// Vector: marching-squares contours over the same field/interpolation.
function renderContours(method: InterpolationMethod): void {
	const grid = new RegularGrid(gridData);
	const pbf = new PbfWriter();
	generateContours(
		pbf,
		values,
		grid,
		tileX,
		tileY,
		tileZ,
		tileSize,
		contourIntervals,
		undefined,
		method,
		DEFAULT_SMOOTH_FOOTPRINT,
		0
	);
	_sink += pbf.finish().length;
}

// Vector: a sparse grid of wind arrows (speed sampled with the method, direction linear).
function renderArrows(method: InterpolationMethod): void {
	const grid = new RegularGrid(gridData);
	const pbf = new PbfWriter();
	generateArrows(
		pbf,
		values,
		directions,
		grid,
		tileX,
		tileY,
		tileZ,
		undefined,
		method,
		DEFAULT_SMOOTH_FOOTPRINT
	);
	_sink += pbf.finish().length;
}

describe('raster — 256x256 tile', () => {
	for (const method of methods) bench(method, () => renderRaster(method));
});

describe('contours — 256x256 tile', () => {
	for (const method of methods) bench(method, () => renderContours(method));
});

describe('wind arrows — 256x256 tile', () => {
	for (const method of methods) bench(method, () => renderArrows(method));
});

// --- 'smooth' SAT: per-tile build (before) vs shared SAB-backed table (after) ---
//
// Before, every tile request built its own summed-area table inside the grid.
// Now the table is built once per data load into SharedArrayBuffers and
// injected into each tile's grid via setSummedAreaTable, leaving only the
// O(1)-per-pixel sampling. The heap-SAT variant injects a table backed by a
// plain ArrayBuffer to isolate what reading from a SAB costs by itself.

const sabSat = buildSummedAreaTable(values, gridData.nx, gridData.ny, true);
const heapSat = buildSummedAreaTable(values, gridData.nx, gridData.ny, false);

describe('smooth SAT per tile — 256x256 data window', () => {
	bench('per-tile SAT build (before / no-SAB fallback)', () => renderRaster('smooth'));
	bench('shared SAB-backed SAT (after)', () => renderRaster('smooth', sabSat));
	bench('shared heap SAT (SAB read-cost reference)', () => renderRaster('smooth', heapSat));
});

describe('SAT build only — 256x256 data window', () => {
	bench('into ArrayBuffer', () => {
		_sink += buildSummedAreaTable(values, gridData.nx, gridData.ny, false).sum[42];
	});
	bench('into SharedArrayBuffer', () => {
		_sink += buildSummedAreaTable(values, gridData.nx, gridData.ny, true).sum[42];
	});
});

// Global 0.25° grid (e.g. ncep_gfs025, 1440x721 ≈ 1M cells): here the build is
// ~16x the 256² window while the per-tile sampling work is unchanged, so the
// shared table's advantage scales with grid size.
const globalGridData: RegularGridData = {
	type: 'regular',
	nx: 1440,
	ny: 721,
	lonMin: -180,
	latMin: -90,
	dx: 0.25,
	dy: 0.25
};

const globalValues = new Float32Array(globalGridData.nx * globalGridData.ny);
for (let j = 0; j < globalGridData.ny; j++) {
	for (let i = 0; i < globalGridData.nx; i++) {
		const v = 10 + 0.01 * i + 0.02 * j + 2 * Math.sin(i / 15) * Math.cos(j / 17);
		globalValues[j * globalGridData.nx + i] = Math.round(v / 0.05) * 0.05;
	}
}

const globalSabSat = buildSummedAreaTable(globalValues, globalGridData.nx, globalGridData.ny, true);

// A z3 mid-latitude tile; the sampling loop is identical to renderRaster.
function renderGlobalSmooth(sat?: SummedAreaTable): void {
	const grid = new RegularGrid(globalGridData);
	if (sat) {
		grid.setSummedAreaTable(sat, globalValues);
	}
	let acc = 0;
	for (let i = 0; i < tileSize; i++) {
		const lat = tile2lat(3 + (i + 0.5) / tileSize, 3);
		for (let j = 0; j < tileSize; j++) {
			const lon = tile2lon(4 + (j + 0.5) / tileSize, 3);
			const v = grid.getInterpolatedValue(
				globalValues,
				lat,
				lon,
				'smooth',
				DEFAULT_SMOOTH_FOOTPRINT
			);
			if (isFinite(v)) acc += v;
		}
	}
	_sink += acc;
}

describe('smooth SAT per tile — global 0.25° grid', () => {
	bench('per-tile SAT build (before / no-SAB fallback)', () => renderGlobalSmooth());
	bench('shared SAB-backed SAT (after)', () => renderGlobalSmooth(globalSabSat));
});
