/**
 * Decode worker: hosts its own WeatherMapLayerFileReader so the wasm
 * decompression of om variables and the u/v→speed/direction (and back)
 * derivation loops run off the main thread — on mobile these freeze the map
 * for hundreds of ms per data load when run inline.
 *
 * With SAB-backed reads (useSAB) the decoded arrays post back zero-copy;
 * plain ArrayBuffers are transferred. The worker cannot share the host's live
 * BlockCache object, so it builds its own BrowserBlockCache from the
 * serializable options in the init message — the same cacheName shares the
 * persistent Cache API layer with the main thread's cache, so blocks fetched
 * by either side (e.g. prefetch warming) serve both.
 */
import { BrowserBlockCache } from '@openmeteo/file-reader';

import { WeatherMapLayerFileReader } from './om-file-reader';

import type { Data, DimensionRange } from './types';

export interface DecodeWorkerInitMessage {
	type: 'init';
	useSAB: boolean;
	retries?: number;
	eTagValidation?: boolean;
	cacheOptions?: ConstructorParameters<typeof BrowserBlockCache>[0];
	/**
	 * Absolute URL of om_reader_wasm.web.wasm, injected into the loader (the
	 * build rewrites its `import.meta.url` lookup, which cannot work from a
	 * blob-URL worker — see injectedWorkerWasmUrl in vite.config.ts).
	 */
	wasmUrl?: string;
}

export interface DecodeWorkerReadMessage {
	type: 'read';
	id: number;
	url: string;
	variable: string;
	ranges: DimensionRange[] | null;
}

interface DecodeWorkerCancelMessage {
	type: 'cancel';
	id: number;
}

export type DecodeWorkerRequest =
	DecodeWorkerInitMessage | DecodeWorkerReadMessage | DecodeWorkerCancelMessage;

export type DecodeWorkerResponse =
	| { type: 'data'; id: number; data: Data }
	| { type: 'error'; id: number; name: string; message: string }
	| { type: 'fatal'; id: -1; message: string };

let reader: WeatherMapLayerFileReader | undefined;
const aborts = new Map<number, AbortController>();

// A worker-side crash outside a request handler (wasm boot, an unawaited
// rejection in a dependency) would otherwise hang its requests forever — the
// parent's onerror only sees synchronous top-level throws. Surface both as a
// fatal message so the client can fall back to main-thread decoding.
self.addEventListener('error', (event) => {
	post({ type: 'fatal', id: -1, message: String(event.message ?? 'worker error') });
});
self.addEventListener('unhandledrejection', (event) => {
	post({ type: 'fatal', id: -1, message: String(event.reason?.message ?? event.reason) });
});

/** Non-SAB buffers of the arrays, for the postMessage transfer list. */
const transferListOf = (arrays: (Float32Array | undefined)[]): ArrayBuffer[] => {
	const buffers: ArrayBuffer[] = [];
	for (const array of arrays) {
		if (array && array.buffer instanceof ArrayBuffer && !buffers.includes(array.buffer)) {
			buffers.push(array.buffer);
		}
	}
	return buffers;
};

const post = (response: DecodeWorkerResponse, transfer: ArrayBuffer[] = []): void => {
	postMessage(response, { transfer });
};

self.onmessage = async (message: MessageEvent<DecodeWorkerRequest>): Promise<void> => {
	const request = message.data;

	if (request.type === 'init') {
		if (request.wasmUrl) {
			(self as { __OM_WASM_URL__?: string }).__OM_WASM_URL__ = request.wasmUrl;
		}
		reader = new WeatherMapLayerFileReader({
			useSAB: request.useSAB,
			retries: request.retries,
			eTagValidation: request.eTagValidation,
			cache: request.cacheOptions ? new BrowserBlockCache(request.cacheOptions) : undefined
		});
		return;
	}

	if (request.type === 'cancel') {
		aborts.get(request.id)?.abort();
		return;
	}

	if (request.type === 'read') {
		const controller = new AbortController();
		aborts.set(request.id, controller);
		try {
			if (!reader) throw new Error('decode worker used before init');
			const data = await reader.readVariable(
				request.url,
				request.variable,
				request.ranges,
				controller.signal
			);
			post({ type: 'data', id: request.id, data }, transferListOf([data.values, data.directions]));
		} catch (error) {
			// A posted error means the worker itself works: the client rethrows it
			// as a data error instead of falling back to a main-thread read.
			post({
				type: 'error',
				id: request.id,
				name: error instanceof Error ? error.name : 'Error',
				message: error instanceof Error ? error.message : String(error)
			});
		} finally {
			aborts.delete(request.id);
		}
		return;
	}
};
