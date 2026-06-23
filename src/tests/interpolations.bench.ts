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
// once per tile exactly as it is in production (the worker creates a new grid
// per tile request).
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

const methods: InterpolationMethod[] = ['nearest', 'linear', 'cubic', 'smooth'];

// prevent the optimiser from discarding the work (intentionally unread)
let _sink = 0;

// Raster: getInterpolatedValue per pixel, sampled at the pixel centre like the worker.
function renderRaster(method: InterpolationMethod): void {
	const grid = new RegularGrid(gridData);
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
