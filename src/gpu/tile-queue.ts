/**
 * Orders GPU tile requests inside the tile worker: requests queue up, are
 * submitted to the renderer as framebuffers free up, and are reported back
 * once their fence signals. Between polls the worker's message loop runs, so
 * cancel messages for tiles the map no longer needs remove them before they
 * cost any GPU time.
 */
import { MissingDataError } from './tile-renderer';
import type { GpuPendingTile, GpuTileRequest } from './tile-renderer';

/** The renderer surface the queue drives; the real one is GpuTileRenderer. */
export interface GpuTileSubmitter {
	readonly inFlight: number;
	readonly maxInFlight: number;
	submit(request: GpuTileRequest): GpuPendingTile | null;
	isFinished(pending: GpuPendingTile): boolean;
	finish(pending: GpuPendingTile): ImageBitmap;
	release(pending: GpuPendingTile): void;
}

export interface GpuTileSink {
	done(key: string, bitmap: ImageBitmap): void;
	/** The renderer lacks the values for the key's data; the pool re-sends them. */
	needData(key: string, dataKey: string): void;
	failed(key: string, request: GpuTileRequest, error: Error): void;
}

export interface GpuQueuedTile {
	key: string;
	request: GpuTileRequest;
}

export class GpuTileQueue {
	private queued: GpuQueuedTile[] = [];
	private inFlight = new Map<string, GpuQueuedTile & { pending: GpuPendingTile }>();
	private pollScheduled = false;

	constructor(
		private renderer: GpuTileSubmitter,
		private sink: GpuTileSink,
		// A short timer rather than a microtask: the message loop must get a
		// turn between polls for cancellations to arrive.
		private schedule: (callback: () => void) => void = (callback) => setTimeout(callback, 1)
	) {}

	enqueue(key: string, request: GpuTileRequest): void {
		this.queued.push({ key, request });
		this.drain();
	}

	/** Forget a tile; true when it was still queued or in flight. */
	cancel(key: string): boolean {
		const index = this.queued.findIndex((entry) => entry.key === key);
		if (index !== -1) {
			this.queued.splice(index, 1);
			return true;
		}
		const entry = this.inFlight.get(key);
		if (entry) {
			this.renderer.release(entry.pending);
			this.inFlight.delete(key);
			return true;
		}
		return false;
	}

	/** Drop everything and return it, so the caller can route it elsewhere. */
	abandon(): GpuQueuedTile[] {
		const entries: GpuQueuedTile[] = [...this.queued];
		for (const entry of this.inFlight.values()) {
			this.renderer.release(entry.pending);
			entries.push({ key: entry.key, request: entry.request });
		}
		this.queued = [];
		this.inFlight.clear();
		return entries;
	}

	private drain(): void {
		while (this.queued.length > 0 && this.renderer.inFlight < this.renderer.maxInFlight) {
			const entry = this.queued.shift()!;
			let pending: GpuPendingTile | null;
			try {
				pending = this.renderer.submit(entry.request);
			} catch (error) {
				if (error instanceof MissingDataError) {
					this.sink.needData(entry.key, error.dataKey);
				} else {
					this.sink.failed(
						entry.key,
						entry.request,
						error instanceof Error ? error : new Error(String(error))
					);
				}
				continue;
			}
			if (!pending) {
				this.queued.unshift(entry);
				break;
			}
			this.inFlight.set(entry.key, { ...entry, pending });
		}
		if (this.inFlight.size > 0) this.schedulePoll();
	}

	private schedulePoll(): void {
		if (this.pollScheduled) return;
		this.pollScheduled = true;
		this.schedule(() => {
			this.pollScheduled = false;
			this.poll();
		});
	}

	private poll(): void {
		for (const [key, entry] of this.inFlight) {
			if (!this.renderer.isFinished(entry.pending)) continue;
			this.inFlight.delete(key);
			try {
				this.sink.done(key, this.renderer.finish(entry.pending));
			} catch (error) {
				this.sink.failed(
					key,
					entry.request,
					error instanceof Error ? error : new Error(String(error))
				);
			}
		}
		this.drain();
	}
}
