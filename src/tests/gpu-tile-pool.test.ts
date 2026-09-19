import { GpuTileRouting } from '../gpu/tile-pool';
import { describe, expect, it, vi } from 'vitest';

import type { TileRequest } from '../types';

const tileRequest = (values: Float32Array, gpu = true): Omit<TileRequest, 'signal'> =>
	({
		type: 'getImage',
		key: 'k',
		gpu,
		data: { values, directions: new Float32Array(2), scaleFactor: 20 }
	}) as Omit<TileRequest, 'signal'>;

describe('GpuTileRouting', () => {
	it('attaches the values of an array only the first time', () => {
		const routing = new GpuTileRouting();
		const values = new Float32Array([1, 2]);

		const first = routing.message(tileRequest(values));
		expect(first.dataKey).toBe('0');
		expect(first.data.values).toBe(values);
		expect(first.data.directions).toBeUndefined();
		expect(first.data.scaleFactor).toBe(20);

		const second = routing.message(tileRequest(values));
		expect(second.dataKey).toBe('0');
		expect(second.data.values).toBeUndefined();

		const other = routing.message(tileRequest(new Float32Array([3])));
		expect(other.dataKey).toBe('1');
		expect(other.data.values).toHaveLength(1);
	});

	it('re-sends the values after the worker reports them missing', () => {
		const routing = new GpuTileRouting();
		const values = new Float32Array([1]);
		routing.message(tileRequest(values));

		const repost = vi.fn();
		routing.handleResponse({ type: 'needData', key: 'k', dataKey: '0' }, repost);
		expect(repost).toHaveBeenCalledWith('k');
		expect(routing.message(tileRequest(values)).data.values).toBe(values);
	});

	it('turns GPU requests into plain requests once the worker has no WebGL2', () => {
		const routing = new GpuTileRouting();
		const request = tileRequest(new Float32Array([1]));
		expect(routing.accepts(request)).toBe(true);

		routing.handleResponse({ type: 'gpuUnavailable' }, vi.fn());
		expect(routing.accepts(request)).toBe(false);
		const message = routing.message(request);
		expect(message.gpu).toBe(false);
		expect(message.dataKey).toBeUndefined();
		expect(message.data).toBe(request.data);
	});

	it('leaves CPU requests untouched', () => {
		const routing = new GpuTileRouting();
		const request = tileRequest(new Float32Array([1]), false);
		expect(routing.accepts(request)).toBe(false);
		expect(routing.message(request)).toBe(request);
		expect(routing.isResponse({ type: 'returnImage' })).toBe(false);
		expect(routing.isResponse({ type: 'needData' })).toBe(true);
	});
});
