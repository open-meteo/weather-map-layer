/**
 * Main-thread side of the GPU tile path, used by the worker pool. All GPU
 * requests go to one worker so there is a single GL context and one value
 * texture per data array, and the values cross the thread boundary once per
 * array instead of once per tile: on non-isolated pages every tile message
 * clones its values, and for a global grid that clone is the whole cost.
 */
import type { TileRequest, WorkerRequest } from '../types';

export type GpuWorkerRequest = WorkerRequest & {
	/** Identity of `data.values` in the worker's texture cache; values are attached on first sight. */
	dataKey?: string;
};

export type GpuWorkerResponse =
	// The worker evicted (or never received) the values behind a data key
	| { type: 'needData'; key: string; dataKey: string }
	// The worker has no WebGL2; requests are plain CPU requests from then on
	| { type: 'gpuUnavailable' };

type PlainRequest = Omit<TileRequest, 'signal'>;

export class GpuTileRouting {
	private dataKeys = new WeakMap<Float32Array, string>();
	private nextDataKey = 0;
	private uploaded = new Set<string>();
	private available = true;

	/** True when the request goes to the GPU worker. */
	accepts(request: PlainRequest): boolean {
		return request.gpu === true && this.available;
	}

	/** The message to post for a request; GPU requests carry the values only the first time. */
	message(request: PlainRequest): GpuWorkerRequest {
		if (!this.accepts(request)) {
			return request.gpu ? { ...request, gpu: false } : request;
		}
		const values = request.data.values;
		if (!values) return request;
		const dataKey = this.dataKeyFor(values);
		const attachValues = !this.uploaded.has(dataKey);
		this.uploaded.add(dataKey);
		// Raster tiles read values only; the directions never leave the main thread
		return {
			...request,
			dataKey,
			data: {
				values: attachValues ? values : undefined,
				directions: undefined,
				scaleFactor: request.data.scaleFactor
			}
		};
	}

	isResponse(data: { type: string }): data is GpuWorkerResponse {
		return data.type === 'needData' || data.type === 'gpuUnavailable';
	}

	/** Consume a GPU response; `repost` re-sends the request of a key that is still pending. */
	handleResponse(data: GpuWorkerResponse, repost: (key: string) => void): void {
		if (data.type === 'gpuUnavailable') {
			this.available = false;
			return;
		}
		this.uploaded.delete(data.dataKey);
		repost(data.key);
	}

	private dataKeyFor(values: Float32Array): string {
		let key = this.dataKeys.get(values);
		if (key === undefined) {
			key = String(this.nextDataKey++);
			this.dataKeys.set(values, key);
		}
		return key;
	}
}
