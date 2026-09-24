import { GridFactory } from '../grids/factory';
import { registerGeometry } from '../grids/latband/geometry';
import { LatBandGrid, parseLatBand } from '../grids/latband/latband';
import { lat2tile, lon2tile, tile2lat, tile2lon } from '../utils/math';
import { describe, expect, test } from 'vitest';

import type { LatBandGridData } from '../types';

const D2R = Math.PI / 180;

/**
 * Writes a LATBAND1 file for a point set the way the backend's
 * ReducedLatLonArtifact.Writer lays it out (band-major buckets, one record per
 * point with its id, reverse directory), so the reader meets the real structure.
 */
const writeLatBand = (
	points: Array<[number, number]>,
	bandCount: number,
	global: boolean
): ArrayBuffer => {
	const h = Math.PI / bandCount;
	const columnsOf = (band: number) =>
		Math.max(1, Math.round((2 * Math.PI * Math.cos(-Math.PI / 2 + (band + 0.5) * h)) / h));
	const bucketed = new Map<number, Map<number, number[]>>();
	points.forEach(([lat, lon], id) => {
		const band = Math.min(bandCount - 1, Math.max(0, Math.floor((lat * D2R + Math.PI / 2) / h)));
		const columns = columnsOf(band);
		let column = Math.floor(((lon * D2R + Math.PI) * columns) / (2 * Math.PI));
		if (column >= columns) column = 0;
		const row = bucketed.get(band) ?? new Map<number, number[]>();
		bucketed.set(band, row);
		row.set(column, [...(row.get(column) ?? []), id]);
	});
	const occupied = [...bucketed.keys()].sort((a, b) => a - b);
	const first = global ? 0 : occupied[0];
	const last = global ? bandCount - 1 : occupied[occupied.length - 1];
	const bands: Array<{ columns: number; startColumn: number; storedColumns: number }> = [];
	let bucketCount = 0;
	for (let band = first; band <= last; band++) {
		const columns = columnsOf(band);
		const row = bucketed.get(band);
		let startColumn = 0;
		let storedColumns = global ? columns : 0;
		if (!global && row) {
			const cols = [...row.keys()];
			startColumn = Math.min(...cols);
			storedColumns = Math.max(...cols) - startColumn + 1;
		}
		bands.push({ columns, startColumn, storedColumns });
		bucketCount += storedColumns;
	}
	const count = points.length;
	const directoryOffset = 64 + bands.length * 16;
	const recordsOffset = Math.ceil((directoryOffset + (bucketCount + 1) * 4) / 16) * 16;
	const reverseOffset = recordsOffset + count * 16;
	const buffer = new ArrayBuffer(reverseOffset + count * 4);
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	bytes.set(
		[...'LATBAND1'].map((c) => c.charCodeAt(0)),
		0
	);
	[1, count, bandCount, first, bands.length, bucketCount, 99, global ? 1 : 0].forEach((v, i) =>
		view.setUint32(8 + i * 4, v, true)
	);
	for (let i = 0; i < 16; i++) bytes[40 + i] = i + 1;
	let firstBucket = 0;
	let position = 0;
	bands.forEach((band, i) => {
		const o = 64 + i * 16;
		view.setUint32(o, band.columns, true);
		view.setUint32(o + 4, band.startColumn, true);
		view.setUint32(o + 8, band.storedColumns, true);
		view.setUint32(o + 12, firstBucket, true);
		const row = bucketed.get(first + i);
		for (let local = 0; local < band.storedColumns; local++) {
			view.setUint32(directoryOffset + (firstBucket + local) * 4, position, true);
			for (const id of row?.get(band.startColumn + local) ?? []) {
				const [lat, lon] = points[id];
				const r = recordsOffset + position * 16;
				view.setFloat32(r, Math.cos(lat * D2R) * Math.cos(lon * D2R), true);
				view.setFloat32(r + 4, Math.cos(lat * D2R) * Math.sin(lon * D2R), true);
				view.setFloat32(r + 8, Math.sin(lat * D2R), true);
				view.setUint32(r + 12, id, true);
				view.setUint32(reverseOffset + id * 4, position, true);
				position++;
			}
		}
		firstBucket += band.storedColumns;
	});
	view.setUint32(directoryOffset + bucketCount * 4, position, true);
	return buffer;
};

let seed = 20260924;
const random = () => {
	seed = (seed * 1103515245 + 12345) % 2147483648;
	return seed / 2147483648;
};

const chord2 = (aLat: number, aLon: number, bLat: number, bLon: number) => {
	const ax = Math.cos(aLat * D2R) * Math.cos(aLon * D2R);
	const ay = Math.cos(aLat * D2R) * Math.sin(aLon * D2R);
	const az = Math.sin(aLat * D2R);
	const bx = Math.cos(bLat * D2R) * Math.cos(bLon * D2R);
	const by = Math.cos(bLat * D2R) * Math.sin(bLon * D2R);
	const bz = Math.sin(bLat * D2R);
	return (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2;
};

const bruteForceNearest = (points: Array<[number, number]>, lat: number, lon: number) => {
	let best = -1;
	let bestDist = Infinity;
	points.forEach(([pLat, pLon], id) => {
		const d = chord2(lat, lon, pLat, pLon);
		if (d < bestDist) {
			bestDist = d;
			best = id;
		}
	});
	return { id: best, chord2: bestDist };
};

// 4000 points spread over the sphere, indexed with 40 latitude bands
const globalPoints: Array<[number, number]> = Array.from({ length: 4000 }, () => [
	(Math.asin(2 * random() - 1) * 180) / Math.PI,
	random() * 360 - 180
]);
const globalFile = writeLatBand(globalPoints, 40, true);
const globalData: LatBandGridData = { type: 'latband', nx: 4000, ny: 1, geometry: 'test://global' };

// a jittered 0.25° lattice over 40–50°N, 0–15°E, indexed with 720 bands (0.25°)
const latticePoints: Array<[number, number]> = [];
for (let lat = 40; lat <= 50; lat += 0.25) {
	for (let lon = 0; lon <= 15; lon += 0.25) {
		latticePoints.push([lat + (random() - 0.5) * 0.1, lon + (random() - 0.5) * 0.1]);
	}
}
const latticeFile = writeLatBand(latticePoints, 720, false);
const latticeData: LatBandGridData = {
	type: 'latband',
	nx: latticePoints.length,
	ny: 1,
	geometry: 'test://lattice'
};
const linearField = new Float32Array(latticePoints.map(([lat, lon]) => 2 * lat + 3 * lon));

describe('LatBandGrid', () => {
	test('parses the header and rejects other files', () => {
		const index = parseLatBand(globalFile);
		expect(index.count).toBe(4000);
		expect(index.bandCount).toBe(40);
		expect(index.global).toBe(true);
		expect(() => parseLatBand(new ArrayBuffer(64))).toThrow(/LATBAND1/);
		expect(() => new LatBandGrid({ ...globalData, nx: 4001 }, globalFile)).toThrow(/4000/);
	});

	test('every centre is its own nearest cell', () => {
		const grid = new LatBandGrid(globalData, globalFile);
		globalPoints.forEach(([lat, lon], id) => expect(grid.findCell(lat, lon)).toBe(id));
	});

	test('nearest cell agrees with brute force, none beyond the acceptance radius', () => {
		const grid = new LatBandGrid(globalData, globalFile);
		const accept = 4 * Math.sin((1.5 * parseLatBand(globalFile).spacing) / 2) ** 2;
		let accepted = 0;
		let rejected = 0;
		for (let i = 0; i < 400; i++) {
			const lat = (Math.asin(2 * random() - 1) * 180) / Math.PI;
			const lon = random() * 360 - 180;
			const truth = bruteForceNearest(globalPoints, lat, lon);
			const cell = grid.findCell(lat, lon);
			if (truth.chord2 < accept) {
				expect(cell).toBe(truth.id);
				accepted++;
			} else {
				expect(cell).toBe(-1);
				rejected++;
			}
		}
		expect(accepted).toBeGreaterThan(300);
		expect(rejected).toBeGreaterThan(0);
	});

	test('limited-area grid: bounds, boundary ring and outside points', () => {
		const grid = new LatBandGrid(latticeData, latticeFile);
		const [west, south, east, north] = grid.getBounds();
		expect(west).toBeGreaterThan(-0.5);
		expect(west).toBeLessThanOrEqual(0);
		expect(east).toBeGreaterThanOrEqual(15);
		expect(east).toBeLessThan(15.5);
		expect(south).toBeLessThanOrEqual(40);
		expect(north).toBeGreaterThanOrEqual(50);
		const ring = grid.getBoundaryPolygon();
		expect(ring.length).toBeGreaterThan(4);
		expect(ring[0]).toEqual(ring[ring.length - 1]);
		for (const [lon, lat] of ring) {
			expect(lon).toBeGreaterThan(-1);
			expect(lon).toBeLessThan(16);
			expect(lat).toBeGreaterThan(39);
			expect(lat).toBeLessThan(51);
		}
		expect(grid.findCell(45, 30)).toBe(-1);
		expect(grid.findCell(20, 7)).toBe(-1);
		expect(grid.findCell(45, 7.5)).toBeGreaterThanOrEqual(0);
		expect(grid.getCoveringRanges(44, 5, 46, 8)).toEqual([
			{ start: 0, end: 1 },
			{ start: 0, end: latticePoints.length }
		]);
	});

	test('linear interpolation reproduces a linear field and is exact at the centres', () => {
		const grid = new LatBandGrid(latticeData, latticeFile);
		for (let i = 0; i < 300; i++) {
			const lat = 41 + random() * 8;
			const lon = 1 + random() * 13;
			expect(grid.getLinearInterpolatedValue(linearField, lat, lon)).toBeCloseTo(
				2 * lat + 3 * lon,
				2
			);
		}
		const [lat, lon] = latticePoints[1234];
		expect(grid.getInterpolatedValue(linearField, lat, lon, 'linear')).toBeCloseTo(
			linearField[1234],
			4
		);
		expect(grid.getInterpolatedValue(linearField, lat, lon, 'nearest')).toBe(linearField[1234]);
		expect(grid.getLinearInterpolatedValue(linearField, 45, 30)).toBeNaN();
	});

	test('directions blend across the 0°/360° seam', () => {
		const grid = new LatBandGrid(latticeData, latticeFile);
		const directions = new Float32Array(latticePoints.map(([, lon]) => (lon < 7.5 ? 350 : 10)));
		const blended = grid.getLinearInterpolatedDirection(directions, 45, 7.5);
		expect(blended >= 340 || blended <= 20).toBe(true);
		expect(grid.getLinearInterpolatedDirection(directions, 45, 3)).toBeCloseTo(350, 5);
	});

	test('renderTile: nearest matches findCell per pixel, linear covers the interior', () => {
		const grid = new LatBandGrid(latticeData, latticeFile);
		const z = 6;
		const size = 64;
		const x = Math.floor(lon2tile(7.5, z));
		const y = Math.floor(lat2tile(45, z));
		const nearest = grid.renderTile(linearField, x, y, z, size, 'nearest');
		const linear = grid.renderTile(linearField, x, y, z, size, 'linear');
		let covered = 0;
		for (let i = 0; i < size; i++) {
			const lat = tile2lat(y + (i + 0.5) / size, z);
			for (let j = 0; j < size; j++) {
				const lon = tile2lon(x + (j + 0.5) / size, z);
				const cell = grid.findCell(lat, lon);
				const expected = cell < 0 ? NaN : linearField[cell];
				if (Number.isNaN(expected)) expect(nearest[i * size + j]).toBeNaN();
				else expect(nearest[i * size + j]).toBe(expected);
				if (cell >= 0 && lat > 41 && lat < 49 && lon > 1 && lon < 14) {
					expect(linear[i * size + j]).toBeCloseTo(2 * lat + 3 * lon, 1);
					covered++;
				}
			}
		}
		expect(covered).toBeGreaterThan(1000);
	});

	test('forEachPoint visits every cell once and honours bounds', () => {
		const grid = new LatBandGrid(latticeData, latticeFile);
		const seen = new Set<number>();
		grid.forEachPoint(({ index, lat, lon }) => {
			expect(seen.has(index)).toBe(false);
			seen.add(index);
			expect(lat).toBeCloseTo(latticePoints[index][0], 3);
			expect(lon).toBeCloseTo(latticePoints[index][1], 3);
		});
		expect(seen.size).toBe(latticePoints.length);
		const inBox: number[] = [];
		grid.forEachPoint(
			({ index, lat, lon }) => {
				inBox.push(index);
				expect(lat).toBeGreaterThanOrEqual(44);
				expect(lat).toBeLessThanOrEqual(46);
				expect(lon).toBeGreaterThanOrEqual(5);
				expect(lon).toBeLessThanOrEqual(8);
			},
			[5, 44, 8, 46]
		);
		const expected = latticePoints.filter(
			([lat, lon]) => lat >= 44 && lat <= 46 && lon >= 5 && lon <= 8
		).length;
		expect(inBox.length).toBe(expected);
		let visits = 0;
		grid.forEachPoint(() => {
			visits++;
			return false;
		});
		expect(visits).toBe(1);
	});
});

describe('GridFactory', () => {
	test('needs the geometry preloaded, then builds and caches the grid', () => {
		expect(() => GridFactory.create(latticeData)).toThrow(/preload/);
		expect(GridFactory.sharedBuffers(latticeData)).toEqual([]);
		registerGeometry(latticeData.geometry, latticeFile);
		const grid = GridFactory.create(latticeData);
		expect(grid).toBeInstanceOf(LatBandGrid);
		expect(GridFactory.create(latticeData)).toBe(grid);
		expect(GridFactory.sharedBuffers(latticeData)).toEqual([
			{ key: latticeData.geometry, buffer: latticeFile }
		]);
	});
});
