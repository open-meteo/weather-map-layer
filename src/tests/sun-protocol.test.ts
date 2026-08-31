import { sunProtocol } from '../sun-protocol';
import { RequestParameters } from 'maplibre-gl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ShadowTileRequest, TileJSON } from '../types';

const { mockRequestTile } = vi.hoisted(() => ({
	mockRequestTile: vi.fn()
}));

vi.mock('../worker-pool-instance', () => ({
	workerPool: { requestTile: mockRequestTile }
}));

const request = (url: string, type: 'json' | 'image') =>
	sunProtocol({ url, type } as RequestParameters, new AbortController());

beforeEach(() => {
	vi.clearAllMocks();
	mockRequestTile.mockResolvedValue({ data: 'bitmap', cancelled: false });
});

describe('sunProtocol', () => {
	it('returns a world-bounds tilejson for json requests', async () => {
		const url = 'sun://shadow?time=2026-08-05T12:00Z';
		const result = await request(url, 'json');
		const tilejson = result.data as TileJSON;

		expect(tilejson.tiles).toStrictEqual([url + '/{z}/{x}/{y}']);
		expect(tilejson.bounds).toStrictEqual([-180, -85.051129, 180, 85.051129]);
		expect(tilejson.minzoom).toBe(0);
	});

	it('requests a shadow tile from the worker pool with parsed options', async () => {
		const result = await request(
			'sun://shadow?time=2026-08-05T12:00Z&opacity=0.8&gradient=12&color=001030&tile_size=512/2/1/3',
			'image'
		);

		expect(result.data).toBe('bitmap');
		const tileRequest = mockRequestTile.mock.calls[0][0] as ShadowTileRequest;
		expect(tileRequest.type).toBe('getShadowImage');
		expect(tileRequest.tileIndex).toStrictEqual({ z: 2, x: 1, y: 3 });
		expect(tileRequest.tileSize).toBe(512);
		expect(tileRequest.shadowOptions).toStrictEqual({
			time: Date.parse('2026-08-05T12:00Z'),
			opacity: 0.8,
			gradient: 12,
			color: [0, 16, 48]
		});
	});

	it('falls back to defaults when parameters are missing', async () => {
		await request('sun://shadow?time=2026-08-05T12:00Z/0/0/0', 'image');

		const tileRequest = mockRequestTile.mock.calls[0][0] as ShadowTileRequest;
		expect(tileRequest.tileSize).toBe(256);
		expect(tileRequest.shadowOptions.opacity).toBe(0.5);
		expect(tileRequest.shadowOptions.gradient).toBe(6);
		expect(tileRequest.shadowOptions.color).toStrictEqual([0, 8, 32]);
	});

	it('returns null for cancelled tile requests', async () => {
		mockRequestTile.mockResolvedValue({ cancelled: true });
		const result = await request('sun://shadow?time=2026-08-05T12:00Z/0/0/0', 'image');
		expect(result.data).toBeNull();
	});

	it('rejects invalid parameters', async () => {
		await expect(request('sun://shadow?time=whenever/0/0/0', 'image')).rejects.toThrow(
			'Invalid sun shadow time'
		);
		await expect(
			request('sun://shadow?time=2026-08-05T12:00Z&color=night/0/0/0', 'image')
		).rejects.toThrow('Invalid sun shadow color');
	});
});
