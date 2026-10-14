/**
 * Tests for the Node tile server handler, against a mock protocol and a real
 * `node:http` server on a free port.
 */
import { createTileHandler, numberOption, parseTileRoute, tileUrl } from '../node/tile-server';
import type { OmProtocol } from '../om-protocol-core';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RgbaTile } from '../types';

const tile = (): RgbaTile => ({ width: 2, height: 2, rgba: new Uint8ClampedArray(16).fill(255) });

/** A protocol answering an opaque 2×2 tile for images and 3 bytes for vectors. */
const createMockProtocol = (
	image: () => RgbaTile | ArrayBuffer = tile,
	delay = 0
): OmProtocol & ReturnType<typeof vi.fn> =>
	vi.fn(async (params: { url: string; type: string }) => {
		if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
		return { data: params.type === 'image' ? image() : new Uint8Array([1, 2, 3]).buffer };
	}) as unknown as OmProtocol & ReturnType<typeof vi.fn>;

let server: Server | undefined;

/** Starts a server with the handler and returns its base URL. */
const listen = async (handler: ReturnType<typeof createTileHandler>): Promise<string> => {
	server = createServer((req, res) => void handler(req, res));
	await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

afterEach(async () => {
	if (server) await new Promise((resolve) => server!.close(resolve));
	server = undefined;
	vi.restoreAllMocks();
});

const LATEST = '/tiles/dwd_icon/latest/current_time_1H/temperature_2m/2/2/1.png';
const RUN = '/tiles/dwd_icon/2026-10-07T0600Z/2026-10-07T1200/temperature_2m/2/2/1.png';

describe('parseTileRoute / tileUrl', () => {
	it('parses the structured route', () => {
		expect(parseTileRoute(RUN)).toEqual({
			domain: 'dwd_icon',
			run: '2026-10-07T0600Z',
			time: '2026-10-07T1200',
			variable: 'temperature_2m',
			z: '2',
			x: '2',
			y: '1',
			format: 'png'
		});
		expect(parseTileRoute('/tiles/2/2/1.png')).toBeUndefined();
		expect(parseTileRoute('/other')).toBeUndefined();
	});

	it('builds the metadata URL for latest with time_step before the tile coordinates', () => {
		expect(tileUrl(parseTileRoute(LATEST)!, '?arrows=true&variable=ignored')).toBe(
			'om://https://openmeteo.s3.amazonaws.com/data_spatial/dwd_icon/latest.json?time_step=current_time_1H&variable=temperature_2m&arrows=true/2/2/1'
		);
	});

	it('builds the model run file URL', () => {
		expect(tileUrl(parseTileRoute(RUN)!, '', 'https://example.com/data')).toBe(
			'om://https://example.com/data/dwd_icon/2026/10/07/0600Z/2026-10-07T1200.om?variable=temperature_2m/2/2/1'
		);
	});
});

describe('createTileHandler', () => {
	it('serves a PNG with CORS and an immutable cache header for a model run', async () => {
		const protocol = createMockProtocol();
		const base = await listen(createTileHandler({ protocol }));

		const response = await fetch(base + RUN);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/png');
		expect(response.headers.get('access-control-allow-origin')).toBe('*');
		expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		const png = new Uint8Array(await response.arrayBuffer());
		expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
		expect(protocol).toHaveBeenCalledWith(
			{
				url: expect.stringContaining('/dwd_icon/2026/10/07/0600Z/2026-10-07T1200.om?'),
				type: 'image'
			},
			expect.any(AbortController),
			expect.objectContaining({ maxStatesWithData: 8 })
		);
	});

	it('serves latest tiles with a short cache header and the query forwarded', async () => {
		const protocol = createMockProtocol();
		const base = await listen(createTileHandler({ protocol, latestMaxAge: 30 }));

		const response = await fetch(
			`${base}/tiles/dwd_icon/latest/current_time_1H/wind_u_component_10m/3/4/2.pbf?arrows=true`
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/x-protobuf');
		expect(response.headers.get('cache-control')).toBe('public, max-age=30');
		expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3]);
		expect(protocol.mock.calls[0][0].url).toBe(
			'om://https://openmeteo.s3.amazonaws.com/data_spatial/dwd_icon/latest.json?time_step=current_time_1H&variable=wind_u_component_10m&arrows=true/3/4/2'
		);
	});

	it('answers 204 for a tile outside the domain', async () => {
		const base = await listen(
			createTileHandler({ protocol: createMockProtocol(() => new ArrayBuffer(0)) })
		);
		const response = await fetch(base + RUN);
		expect(response.status).toBe(204);
	});

	it('404s other paths and unknown domains', async () => {
		const base = await listen(createTileHandler({ protocol: createMockProtocol() }));
		expect((await fetch(`${base}/tiles/2/2/1.png`)).status).toBe(404);
		expect(
			(await fetch(`${base}/tiles/nope/latest/current_time_1H/temperature_2m/2/2/1.png`)).status
		).toBe(404);
	});

	it('renders a tile once for repeated and concurrent requests', async () => {
		const protocol = createMockProtocol(tile, 20);
		const base = await listen(createTileHandler({ protocol }));

		const responses = await Promise.all([fetch(base + RUN), fetch(base + RUN)]);
		expect(responses.map((r) => r.status)).toEqual([200, 200]);
		expect(protocol).toHaveBeenCalledTimes(1);

		await fetch(base + RUN);
		expect(protocol).toHaveBeenCalledTimes(1);
		// Another query is another tile
		await fetch(base + RUN + '?colorscale=wind');
		expect(protocol).toHaveBeenCalledTimes(2);
	});

	it('evicts the least recently used tile beyond the cache size', async () => {
		const protocol = createMockProtocol();
		const base = await listen(createTileHandler({ protocol, cacheSize: 1 }));

		await fetch(base + RUN);
		await fetch(base + RUN.replace('/2/2/1', '/2/2/0'));
		await fetch(base + RUN);
		expect(protocol).toHaveBeenCalledTimes(3);
	});

	it('answers a generic 500 and logs the detail when rendering fails', async () => {
		const protocol = vi.fn(async () => {
			throw new Error('no data');
		}) as unknown as OmProtocol;
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const base = await listen(createTileHandler({ protocol }));
		const response = await fetch(base + RUN);
		expect(response.status).toBe(500);
		// Data URLs, reader and network details stay in the log
		expect(await response.text()).toBe('Tile rendering failed');
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining(RUN),
			expect.objectContaining({ message: 'no data' })
		);
	});

	it('refreshes an expired latest tile as the most recently used entry', async () => {
		const protocol = createMockProtocol();
		const base = await listen(createTileHandler({ protocol, cacheSize: 2, latestMaxAge: 1 }));
		const OTHER = RUN.replace('/2/2/1', '/2/2/0');

		await fetch(base + LATEST);
		await fetch(base + RUN);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
		await fetch(base + LATEST); // expired: rendered again
		await fetch(base + OTHER); // a third entry evicts the least recently used one
		await fetch(base + LATEST);
		// The refreshed tile had moved to the recent end, so the run tile went instead
		expect(protocol).toHaveBeenCalledTimes(4);
	});

	it('refuses further renders with 503 while maxPending tiles render', async () => {
		const protocol = createMockProtocol(tile, 50);
		const base = await listen(createTileHandler({ protocol, maxPending: 1 }));
		const OTHER = RUN.replace('/2/2/1', '/2/2/0');

		const first = fetch(base + RUN);
		await new Promise((resolve) => setTimeout(resolve, 10)); // the render is under way
		const duplicate = fetch(base + RUN); // joins it instead of counting as another
		const refused = await fetch(base + OTHER);
		expect(refused.status).toBe(503);
		expect(refused.headers.get('retry-after')).toBe('1');
		expect((await first).status).toBe(200);
		expect((await duplicate).status).toBe(200);
		expect(protocol).toHaveBeenCalledTimes(1);
		// Once it is done, rendering resumes
		expect((await fetch(base + OTHER)).status).toBe(200);
	});

	it('rejects tile sizes above 512 with 400', async () => {
		const protocol = createMockProtocol();
		const base = await listen(createTileHandler({ protocol }));
		expect((await fetch(`${base}${RUN}?tile_size=1024`)).status).toBe(400);
		expect((await fetch(`${base}${RUN}?tile_size=abc`)).status).toBe(400);
		expect((await fetch(`${base}${RUN}?tile_size=256`)).status).toBe(200);
		expect(protocol).toHaveBeenCalledTimes(1);
	});
});

describe('numberOption', () => {
	it('reads a configuration number and rejects malformed values', () => {
		expect(numberOption('PORT', undefined)).toBeUndefined();
		expect(numberOption('PORT', '')).toBeUndefined();
		expect(numberOption('PORT', '8080')).toBe(8080);
		expect(() => numberOption('TILE_CACHE_SIZE', 'abc')).toThrow(/TILE_CACHE_SIZE/);
		expect(() => numberOption('TILE_CACHE_SIZE', '-1')).toThrow(/non-negative/);
	});
});
