// Grid geometry fetched from outside the bundle (a LATBAND1 cell index, see
// latband.ts) and its triangulation, keyed by URL. The main thread loads both
// once through GridFactory.preload, triangulating in a tile worker, and hands
// them to the tile workers (WorkerPool.share), which register them here
// before any tile of that grid is rendered.
import { LatBandGrid } from './latband';
import type { LatBandTriangulation } from './triangulation';

export interface GridGeometry {
	/** The LATBAND1 file. */
	buffer: ArrayBufferLike;
	triangulation: LatBandTriangulation;
}

/** Computes a file's triangulation; the om protocol runs it in a tile worker. */
export type Triangulator = (buffer: ArrayBufferLike) => Promise<LatBandTriangulation>;

let triangulator: Triangulator = async (buffer) =>
	LatBandGrid.triangulate(
		buffer,
		typeof SharedArrayBuffer !== 'undefined' ? SharedArrayBuffer : ArrayBuffer
	);

export const setTriangulator = (triangulate: Triangulator): void => {
	triangulator = triangulate;
};

const geometries = new Map<string, GridGeometry>();
const pending = new Map<string, Promise<void>>();

export const getGeometry = (url: string): GridGeometry | undefined => geometries.get(url);

export const registerGeometry = (url: string, geometry: GridGeometry): void => {
	geometries.set(url, geometry);
};

/** Fetches, triangulates and registers a geometry once; concurrent and repeated calls share the work. */
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
			registerGeometry(url, { buffer, triangulation: await triangulator(buffer) });
		})().finally(() => pending.delete(url));
		pending.set(url, load);
	}
	return load;
};
