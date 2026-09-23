import { GpuTileQueue } from '../gpu/tile-queue';
import type { GpuTileSink, GpuTileSubmitter } from '../gpu/tile-queue';
import { MissingDataError } from '../gpu/tile-renderer';
import type { GpuPendingTile, GpuTileRequest } from '../gpu/tile-renderer';
import { describe, expect, it, vi } from 'vitest';

/** A renderer stand-in: tiles finish when the test says so. */
class FakeRenderer implements GpuTileSubmitter {
	inFlight = 0;
	submitted: string[] = [];
	released: string[] = [];
	private finished = new Set<string>();

	constructor(
		public maxInFlight = 8,
		private missing = new Set<string>()
	) {}

	submit(request: GpuTileRequest): GpuPendingTile | null {
		if (this.missing.has(request.dataKey)) throw new MissingDataError(request.dataKey);
		if (this.inFlight >= this.maxInFlight) return null;
		this.inFlight++;
		this.submitted.push(request.dataKey);
		return { tileSize: 256, sync: request.dataKey } as unknown as GpuPendingTile;
	}

	isFinished(pending: GpuPendingTile): boolean {
		return this.finished.has(pending.sync as unknown as string);
	}

	finish(pending: GpuPendingTile): ImageBitmap {
		this.release(pending);
		return { tag: pending.sync } as unknown as ImageBitmap;
	}

	release(pending: GpuPendingTile): void {
		this.inFlight--;
		this.released.push(pending.sync as unknown as string);
	}

	complete(dataKey: string): void {
		this.finished.add(dataKey);
	}
}

const request = (dataKey: string): GpuTileRequest =>
	({ dataKey, tileIndex: { z: 1, x: 0, y: 0 } }) as GpuTileRequest;

const setup = (renderer = new FakeRenderer()) => {
	const polls: Array<() => void> = [];
	const sink: GpuTileSink = { done: vi.fn(), needData: vi.fn(), failed: vi.fn() };
	const queue = new GpuTileQueue(renderer, sink, (callback) => polls.push(callback));
	const poll = () => polls.splice(0).forEach((callback) => callback());
	return { renderer, sink, queue, poll };
};

describe('GpuTileQueue', () => {
	it('reports a tile once its fence has signalled', () => {
		const { renderer, sink, queue, poll } = setup();
		queue.enqueue('a', request('d1'));
		expect(renderer.submitted).toEqual(['d1']);

		poll();
		expect(sink.done).not.toHaveBeenCalled();

		renderer.complete('d1');
		poll();
		expect(sink.done).toHaveBeenCalledWith('a', { tag: 'd1' });
		expect(renderer.inFlight).toBe(0);
	});

	it('holds tiles back while every framebuffer is busy', () => {
		const { renderer, queue, poll } = setup(new FakeRenderer(1));
		queue.enqueue('a', request('d1'));
		queue.enqueue('b', request('d2'));
		expect(renderer.submitted).toEqual(['d1']);

		renderer.complete('d1');
		poll();
		expect(renderer.submitted).toEqual(['d1', 'd2']);
	});

	it('drops cancelled tiles whether queued or in flight', () => {
		const { renderer, sink, queue, poll } = setup(new FakeRenderer(1));
		queue.enqueue('a', request('d1'));
		queue.enqueue('b', request('d2'));

		expect(queue.cancel('b')).toBe(true);
		expect(queue.cancel('a')).toBe(true);
		expect(renderer.released).toEqual(['d1']);
		expect(queue.cancel('a')).toBe(false);

		renderer.complete('d1');
		poll();
		expect(sink.done).not.toHaveBeenCalled();
		expect(renderer.submitted).toEqual(['d1']);
	});

	it('asks for the values when the renderer does not have them', () => {
		const { sink, queue } = setup(new FakeRenderer(8, new Set(['d9'])));
		queue.enqueue('a', request('d9'));
		expect(sink.needData).toHaveBeenCalledWith('a', 'd9');
		expect(sink.done).not.toHaveBeenCalled();
	});

	it('hands everything back on abandon', () => {
		const { renderer, queue } = setup(new FakeRenderer(1));
		queue.enqueue('a', request('d1'));
		queue.enqueue('b', request('d2'));
		const abandoned = queue.abandon();
		expect(abandoned.map((entry) => entry.key)).toEqual(['b', 'a']);
		expect(renderer.inFlight).toBe(0);
	});
});
