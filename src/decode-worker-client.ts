/**
 * Main-thread client of the decode worker (see decode-worker.ts). Created per
 * protocol instance when the host opts in by providing serializable
 * `workerCacheOptions` in its fileReaderConfig — the worker cannot clone a
 * live BlockCache object, so it needs the options to build its own.
 *
 * Failure model: an error the worker *posts* is a data error (missing file,
 * network) and rethrows to the caller like a direct read would. A crash of
 * the worker itself (script/wasm failed to boot, uncaught exception) marks
 * the client broken and rejects with `DecodeWorkerBroken`; ensureData then
 * falls back to the main-thread reader for that and all future reads.
 */
import type {
	DecodeWorkerInitMessage,
	DecodeWorkerReadMessage,
	DecodeWorkerRequest,
	DecodeWorkerResponse
} from './decode-worker';
import DecodeWorker from './decode-worker?worker&inline';
import type { FileReaderConfig } from './om-file-reader';

import type { Data, DimensionRange } from './types';

interface Pending {
	resolve: (response: DecodeWorkerResponse) => void;
	reject: (error: Error) => void;
}

const brokenError = (): Error => {
	const error = new Error('decode worker crashed');
	error.name = 'DecodeWorkerBroken';
	return error;
};

const abortError = (): Error => new DOMException('Aborted', 'AbortError');

export class DecodeWorkerClient {
	private worker: Worker;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private failed = false;

	/** True once any request completed; earlier failures count as boot failures. */
	private everSucceeded = false;
	/** Pre-success failures; a few in a row mean the worker cannot boot here. */
	private bootFailures = 0;

	constructor(init: Omit<DecodeWorkerInitMessage, 'type'>) {
		this.worker = new DecodeWorker();
		this.worker.onmessage = (message: MessageEvent<DecodeWorkerResponse>) => {
			const response = message.data;
			if (response.type === 'fatal') {
				this.markBroken();
				return;
			}
			const entry = this.pending.get(response.id);
			if (!entry) return;
			this.pending.delete(response.id);
			if (response.type === 'error') {
				if (response.name !== 'AbortError' && !this.everSucceeded) {
					// The worker has not managed a single read yet, so this may be a
					// broken environment (wasm cannot boot in a worker here) rather
					// than a data error. Reject as broken — the caller retries on the
					// main thread either way — and only write the worker off after a
					// few strikes, so a genuinely missing first file (404) does not
					// disable it for the whole session.
					if (++this.bootFailures >= 3) this.markBroken();
					entry.reject(brokenError());
					return;
				}
				const error =
					response.name === 'AbortError'
						? abortError()
						: Object.assign(new Error(response.message), { name: response.name });
				entry.reject(error);
			} else {
				this.everSucceeded = true;
				entry.resolve(response);
			}
		};
		this.worker.onerror = () => this.markBroken();
		this.send({ type: 'init', ...init });
	}

	/** The worker is unusable: fail everything over to the main-thread reader. */
	private markBroken(): void {
		if (this.failed) return;
		this.failed = true;
		// Visible on purpose: without it a broken worker silently degrades every
		// data load back to main-thread decoding (the mobile freeze this exists
		// to avoid), which is hard to distinguish from the worker working.
		console.warn('om decode worker unavailable — falling back to main-thread decoding');
		for (const entry of this.pending.values()) entry.reject(brokenError());
		this.pending.clear();
		this.worker.terminate();
	}

	/** True once the worker crashed; callers use the main-thread reader instead. */
	get broken(): boolean {
		return this.failed;
	}

	private send(request: DecodeWorkerRequest): void {
		this.worker.postMessage(request);
	}

	private request<T extends DecodeWorkerResponse['type']>(
		build: (id: number) => DecodeWorkerRequest,
		expected: T,
		signal?: AbortSignal
	): Promise<Extract<DecodeWorkerResponse, { type: T }>> {
		if (this.failed) return Promise.reject(brokenError());
		if (signal?.aborted) return Promise.reject(abortError());
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const onAbort = (): void => {
				this.send({ type: 'cancel', id });
				const entry = this.pending.get(id);
				if (entry) {
					this.pending.delete(id);
					entry.reject(abortError());
				}
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			this.pending.set(id, {
				resolve: (response) => {
					signal?.removeEventListener('abort', onAbort);
					if (response.type !== expected) {
						reject(new Error(`decode worker: expected ${expected}, got ${response.type}`));
						return;
					}
					resolve(response as Extract<DecodeWorkerResponse, { type: T }>);
				},
				reject: (error) => {
					signal?.removeEventListener('abort', onAbort);
					reject(error);
				}
			});
			this.send(build(id));
		});
	}

	/** readVariable in the worker: wasm decode + derivation off the main thread. */
	async readVariable(
		url: string,
		variable: string,
		ranges: DimensionRange[] | null,
		signal?: AbortSignal
	): Promise<Data> {
		const message = (id: number): DecodeWorkerReadMessage => ({
			type: 'read',
			id,
			url,
			variable,
			ranges
		});
		const response = await this.request(message, 'data', signal);
		return response.data;
	}
}

/**
 * The decode worker for a fileReaderConfig, or undefined when the environment
 * has no workers or the host did not opt in with `workerCacheOptions`.
 */
export const createDecodeWorkerClient = (
	config: FileReaderConfig
): DecodeWorkerClient | undefined => {
	if (typeof Worker === 'undefined' || typeof window === 'undefined') return undefined;
	if (!config.workerCacheOptions) return undefined;
	try {
		return new DecodeWorkerClient({
			useSAB: config.useSAB ?? typeof SharedArrayBuffer !== 'undefined',
			retries: config.retries,
			eTagValidation: config.eTagValidation,
			cacheOptions: config.workerCacheOptions,
			wasmUrl: config.workerWasmUrl
		});
	} catch {
		return undefined;
	}
};
