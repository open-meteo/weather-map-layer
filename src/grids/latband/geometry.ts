// Grid geometry fetched from outside the bundle (a LATBAND1 cell index, see
// latband.ts), keyed by URL. The main thread loads it once through
// GridFactory.preload and hands the buffer to the tile workers (WorkerPool.share),
// which register it here before any tile of that grid is rendered.

const geometries = new Map<string, ArrayBufferLike>();
const pending = new Map<string, Promise<void>>();

export const getGeometry = (url: string): ArrayBufferLike | undefined => geometries.get(url);

export const registerGeometry = (url: string, buffer: ArrayBufferLike): void => {
	geometries.set(url, buffer);
};

/** Fetches and registers a geometry once; concurrent and repeated calls share the fetch. */
export const loadGeometry = (url: string): Promise<void> => {
	if (geometries.has(url)) return Promise.resolve();
	let load = pending.get(url);
	if (!load) {
		load = (async () => {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`grid geometry fetch failed (${response.status}): ${url}`);
			}
			const bytes = await response.arrayBuffer();
			// On cross-origin isolated pages a SharedArrayBuffer lets every tile
			// worker use this one copy; elsewhere each worker receives a clone.
			let buffer: ArrayBufferLike = bytes;
			if (typeof SharedArrayBuffer !== 'undefined') {
				const shared = new SharedArrayBuffer(bytes.byteLength);
				new Uint8Array(shared).set(new Uint8Array(bytes));
				buffer = shared;
			}
			registerGeometry(url, buffer);
		})().finally(() => pending.delete(url));
		pending.set(url, load);
	}
	return load;
};
