import { MainThreadRenderer } from '../node/main-thread-renderer';
import { encodePng } from '../node/png';
import { WorkerThreadPool } from '../node/worker-thread-pool';
import { existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

import type {
	Domain,
	GridData,
	LayerRenderData,
	RenderOptions,
	ResolvedBreakpointColorScale,
	RgbaTile,
	TileRequest
} from '../types';

// A coarse global regular grid with data everywhere, so any tile has values.
const globalGridData: GridData = {
	type: 'regular',
	nx: 36,
	ny: 18,
	latMin: -90,
	lonMin: -180,
	dx: 10,
	dy: 10,
	zoom: 1
};

const globalLayer = (value: number): LayerRenderData => ({
	domain: { value: 'global', grid: globalGridData } as Domain,
	data: { values: new Float32Array(36 * 18).fill(value), directions: undefined },
	ranges: [
		{ start: 0, end: globalGridData.ny },
		{ start: 0, end: globalGridData.nx }
	]
});

const colorScale: ResolvedBreakpointColorScale = {
	type: 'breakpoint',
	unit: '',
	breakpoints: [0, 10, 20],
	colors: [
		[0, 0, 255, 1],
		[0, 255, 0, 1],
		[255, 0, 0, 1]
	]
};

const renderOptions = (overrides: Partial<RenderOptions> = {}): RenderOptions => ({
	tileSize: 64,
	interpolation: 'nearest',
	colorBlend: false,
	drawGrid: false,
	drawArrows: false,
	arrowStyle: 'arrow',
	drawContours: false,
	intervals: [5],
	colorScale,
	...overrides
});

const request = (
	type: 'getImage' | 'getArrayBuffer',
	overrides: Partial<RenderOptions> = {}
): TileRequest => ({
	type,
	key: `${type}:test`,
	layers: [globalLayer(15)],
	tileIndex: { z: 1, x: 0, y: 0 },
	renderOptions: renderOptions(overrides),
	clippingOptions: undefined
});

describe('MainThreadRenderer', () => {
	const renderer = new MainThreadRenderer();

	it('renders a raster tile as straight-alpha RGBA of the tile size', async () => {
		const { data, cancelled } = await renderer.requestTile(request('getImage'));
		expect(cancelled).toBe(false);
		const tile = data as RgbaTile;
		expect(tile.width).toBe(64);
		expect(tile.height).toBe(64);
		expect(tile.rgba).toBeInstanceOf(Uint8ClampedArray);
		expect(tile.rgba.length).toBe(64 * 64 * 4);
		// 15 falls in the [10, 20) band, so every pixel is the opaque green colour.
		expect(Array.from(tile.rgba.subarray(0, 4))).toEqual([0, 255, 0, 255]);
		expect(tile.rgba.every((_, i) => i % 4 !== 3 || tile.rgba[i] === 255)).toBe(true);
	});

	it('renders a vector tile as a PBF ArrayBuffer', async () => {
		const { data, cancelled } = await renderer.requestTile(
			request('getArrayBuffer', { drawContours: true })
		);
		expect(cancelled).toBe(false);
		expect(data).toBeInstanceOf(ArrayBuffer);
		expect((data as ArrayBuffer).byteLength).toBeGreaterThan(0);
	});

	it('resolves as cancelled when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await renderer.requestTile({
			...request('getImage'),
			signal: controller.signal
		});
		expect(result).toEqual({ cancelled: true });
	});

	it('rejects polygon clipping', async () => {
		const polygons = {
			coordinates: new Float64Array(0),
			offsets: new Uint32Array([0]),
			polygonOffsets: new Uint32Array([0])
		};
		await expect(
			renderer.requestTile({
				...request('getImage'),
				clippingOptions: { polygons, fillRule: 'nonzero' }
			})
		).rejects.toThrow('Polygon clipping is not supported');
	});
});

describe('encodePng', () => {
	const width = 3;
	const height = 2;
	const rgba = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) % 256;
	const png = encodePng({ width, height, rgba });
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);

	it('starts with the PNG signature and an IHDR of the right dimensions', () => {
		expect(Array.from(png.subarray(0, 8))).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
		]);
		expect(view.getUint32(8)).toBe(13);
		expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR');
		expect(view.getUint32(16)).toBe(width);
		expect(view.getUint32(20)).toBe(height);
		expect(png[24]).toBe(8); // bit depth
		expect(png[25]).toBe(6); // RGBA
	});

	it('stores the pixels unfiltered in the IDAT chunk', () => {
		// IHDR chunk is 12 + 13 bytes after the 8-byte signature.
		const idatOffset = 8 + 25;
		const idatLength = view.getUint32(idatOffset);
		expect(String.fromCharCode(...png.subarray(idatOffset + 4, idatOffset + 8))).toBe('IDAT');
		const raw = inflateSync(png.subarray(idatOffset + 8, idatOffset + 8 + idatLength));
		expect(raw.length).toBe(height * (1 + width * 4));
		for (let row = 0; row < height; row++) {
			const start = row * (1 + width * 4);
			expect(raw[start]).toBe(0);
			expect(Array.from(raw.subarray(start + 1, start + 1 + width * 4))).toEqual(
				Array.from(rgba.subarray(row * width * 4, (row + 1) * width * 4))
			);
		}
	});

	it('ends with an IEND chunk', () => {
		expect(String.fromCharCode(...png.subarray(png.length - 8, png.length - 4))).toBe('IEND');
	});
});

// The thread script is the built `dist/node-worker.mjs` (a thread cannot load
// the TypeScript source), so these tests need `npm run build` first.
const workerUrl = new URL('../../dist/node-worker.mjs', import.meta.url);

describe.skipIf(!existsSync(workerUrl))('WorkerThreadPool', () => {
	const pool = new WorkerThreadPool({ size: 2, workerUrl });
	afterAll(() => pool.terminate());

	it('renders raster tiles on the threads', async () => {
		const results = await Promise.all([
			pool.requestTile(request('getImage')),
			pool.requestTile(request('getImage')),
			pool.requestTile(request('getImage'))
		]);
		for (const result of results) {
			expect(result.cancelled).toBe(false);
			const tile = result.data as RgbaTile;
			expect(tile.width).toBe(64);
			expect(tile.rgba).toBeInstanceOf(Uint8ClampedArray);
			expect(tile.rgba.length).toBe(64 * 64 * 4);
			// 15 falls in the green band
			expect(Array.from(tile.rgba.subarray(0, 4))).toEqual([0, 255, 0, 255]);
		}
	});

	it('renders vector tiles on the threads', async () => {
		const result = await pool.requestTile(request('getArrayBuffer', { drawContours: true }));
		expect(result.data).toBeInstanceOf(ArrayBuffer);
		expect((result.data as ArrayBuffer).byteLength).toBeGreaterThan(0);
	});

	it('rejects with the thread error', async () => {
		const polygons = {
			coordinates: new Float64Array(0),
			offsets: new Uint32Array([0]),
			polygonOffsets: new Uint32Array([0])
		};
		await expect(
			pool.requestTile({
				...request('getImage'),
				clippingOptions: { polygons, fillRule: 'nonzero' }
			})
		).rejects.toThrow('Polygon clipping is not supported');
	});

	it('resolves as cancelled when the signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			pool.requestTile({ ...request('getImage'), signal: controller.signal })
		).resolves.toEqual({
			cancelled: true
		});
	});
});
