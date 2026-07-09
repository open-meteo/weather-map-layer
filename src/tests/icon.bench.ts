import { IconGrid } from '../grids/icon';
import { IconGridAnalytical } from '../grids/icon-analytical';
import type { GridInterface } from '../grids/interface';
import { RegularGrid } from '../grids/regular';
import { tile2lat, tile2lon } from '../utils/math';
import { bench, describe } from 'vitest';

import type { InterpolationMethod } from '../types';

// Icon-only interpolation/render benchmark. Run in isolation with
//   npm run bench:icon
// (the full interpolations.bench.ts spins up a worker pool and is slow).
//
// Real-world workload: it replays worker.ts's per-pixel sampling loop
// (tile2lat/tile2lon → getInterpolatedValue) over a viewport of mercator tiles,
// the way production renders a raster layer. Compares the native ICON R3B07
// grid (2.95M cells) against an equivalent global regular grid, and across the
// implementation variants ("iteration steps"):
//   - nearest, exact           (per-pixel descent + inverse-warp, cached)
//   - linear, dual-mesh          (mean-value coords over the ring of cell centres)
// A regular grid nearest/linear is the speed reference.

const n = 3;
const k = 7;
const nx = 20 * n * n * 4 ** k; // 2 949 120

const iconExact = new IconGrid({
	type: 'icon',
	nx,
	ny: 1,
	iconRoot: n,
	iconBisections: k
} as never);
// purely-analytical variant (no 810 KB table; ~33 KB of coefficients)
const iconAnalytical = new IconGridAnalytical({
	type: 'icon',
	nx,
	ny: 1,
	iconRoot: n,
	iconBisections: k
} as never);

const rnx = 2880;
const rny = 1441;
const regular = new RegularGrid({
	type: 'regular',
	nx: rnx,
	ny: rny,
	lonMin: -180,
	latMin: -90,
	dx: 360 / rnx,
	dy: 180 / (rny - 1)
} as never);

// gently-varying quantised field (temperature-like), for both grids
const iconValues = new Float32Array(nx);
for (let i = 0; i < nx; i++) {
	const { lat, lon } = iconExact.cellCoordinates(i);
	iconValues[i] =
		Math.round((10 + 0.1 * lat + 2 * Math.sin(lon / 12) * Math.cos(lat / 9)) / 0.05) * 0.05;
}
const regValues = new Float32Array(rnx * rny);
for (let j = 0; j < rny; j++) {
	const lat = -90 + (j * 180) / (rny - 1);
	for (let i = 0; i < rnx; i++) {
		const lon = -180 + (i * 360) / rnx;
		regValues[j * rnx + i] =
			Math.round((10 + 0.1 * lat + 2 * Math.sin(lon / 12) * Math.cos(lat / 9)) / 0.05) * 0.05;
	}
}

const tileSize = 256;

// a small viewport of tiles over central Europe (like the screenshots), at two
// zooms: z6 (cells ≈ a few px, worst case for coherence) and z8 (cells span
// many px). center ≈ 47°N 8°E.
const viewports: Array<{ label: string; z: number; tiles: Array<[number, number]> }> = [
	{ label: 'z6 (2×2)', z: 6, tiles: block(6, 47, 8, 2) },
	{ label: 'z8 (2×2)', z: 8, tiles: block(8, 47, 8, 2) }
];

function block(z: number, lat: number, lon: number, r: number): Array<[number, number]> {
	const s = 2 ** z;
	const cx = Math.floor(((lon + 180) / 360) * s);
	const latRad = (lat * Math.PI) / 180;
	const cy = Math.floor(
		((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * s
	);
	const out: Array<[number, number]> = [];
	for (let y = cy; y < cy + r; y++) for (let x = cx; x < cx + r; x++) out.push([x, y]);
	return out;
}

// replays the worker.ts inner loop for one tile; returns a checksum so nothing
// is optimised away
function renderTile(
	grid: GridInterface,
	values: Float32Array,
	method: InterpolationMethod,
	x: number,
	y: number,
	z: number
): number {
	let acc = 0;
	const lons = new Float64Array(tileSize);
	for (let j = 0; j < tileSize; j++) lons[j] = tile2lon(x + (j + 0.5) / tileSize, z);
	for (let i = 0; i < tileSize; i++) {
		const lat = tile2lat(y + (i + 0.5) / tileSize, z);
		for (let j = 0; j < tileSize; j++) {
			const v = grid.getInterpolatedValue(values, lat, lons[j], method);
			if (v === v) acc += v; // ignore NaN
		}
	}
	return acc;
}

const perPixelViewport = (
	grid: GridInterface,
	values: Float32Array,
	method: InterpolationMethod,
	tiles: Array<[number, number]>,
	z: number
): number => {
	let acc = 0;
	for (const [x, y] of tiles) acc += renderTile(grid, values, method, x, y, z);
	return acc;
};

// the production render path (worker.ts): rasterise the native triangles
const rasterViewport = (
	grid: GridInterface,
	values: Float32Array,
	method: InterpolationMethod,
	tiles: Array<[number, number]>,
	z: number
): number => {
	let acc = 0;
	for (const [x, y] of tiles) {
		const buf = grid.renderTile!(values, x, y, z, tileSize, method);
		for (let i = 0; i < buf.length; i++) if (buf[i] === buf[i]) acc += buf[i];
	}
	return acc;
};

for (const vp of viewports) {
	describe(`ICON render — ${vp.label} viewport (${vp.tiles.length} tiles, ${tileSize}² px)`, () => {
		bench(
			'regular      · nearest (per-pixel)',
			() => void perPixelViewport(regular, regValues, 'nearest', vp.tiles, vp.z)
		);
		bench(
			'regular      · linear  (per-pixel)',
			() => void perPixelViewport(regular, regValues, 'linear', vp.tiles, vp.z)
		);
		bench(
			'icon table   · nearest (per-pixel)',
			() => void perPixelViewport(iconExact, iconValues, 'nearest', vp.tiles, vp.z)
		);
		bench(
			'icon table   · linear  (per-pixel)',
			() => void perPixelViewport(iconExact, iconValues, 'linear', vp.tiles, vp.z)
		);
		bench(
			'icon table   · nearest (RASTERISE)',
			() => void rasterViewport(iconExact, iconValues, 'nearest', vp.tiles, vp.z)
		);
		bench(
			'icon table   · linear  (RASTERISE)',
			() => void rasterViewport(iconExact, iconValues, 'linear', vp.tiles, vp.z)
		);
	});
}
void iconAnalytical;
