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

/** How far a grid geometry has loaded (see onGridLoadProgress). */
export interface GridLoadProgress {
	/** The geometry's URL. */
	url: string;
	/**
	 * 'download' while the file streams in, 'triangulate' while its mesh is
	 * built (seconds for a global grid), then 'ready' or 'error'.
	 */
	phase: 'download' | 'triangulate' | 'ready' | 'error';
	/** Bytes received so far. */
	loaded: number;
	/** Bytes expected (Content-Length), 0 if unknown. */
	total: number;
}

type ProgressListener = (progress: GridLoadProgress) => void;

const listeners = new Set<ProgressListener>();

/**
 * Calls `listener` while a file-backed grid (native ICON) loads: its file is
 * tens of megabytes, worth a progress display. Returns the unsubscribe.
 */
export const onGridLoadProgress = (listener: ProgressListener): (() => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

const report = (progress: GridLoadProgress): void => {
	for (const listener of listeners) listener({ ...progress });
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
			const progress: GridLoadProgress = { url, phase: 'download', loaded: 0, total: 0 };
			try {
				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`grid geometry fetch failed (${response.status}): ${url}`);
				}
				progress.total = Number(response.headers.get('Content-Length')) || 0;
				report(progress);
				const chunks: Uint8Array[] = [];
				const reader = response.body!.getReader();
				for (let read = await reader.read(); !read.done; read = await reader.read()) {
					chunks.push(read.value);
					progress.loaded += read.value.byteLength;
					report(progress);
				}
				// On cross-origin isolated pages a SharedArrayBuffer lets every tile
				// worker use this one copy; elsewhere each worker receives a clone.
				const buffer =
					typeof SharedArrayBuffer !== 'undefined'
						? new SharedArrayBuffer(progress.loaded)
						: new ArrayBuffer(progress.loaded);
				const bytes = new Uint8Array(buffer);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.byteLength;
				}
				progress.phase = 'triangulate';
				report(progress);
				registerGeometry(url, { buffer, triangulation: await triangulator(buffer) });
				progress.phase = 'ready';
				report(progress);
			} catch (error) {
				progress.phase = 'error';
				report(progress);
				throw error;
			}
		})().finally(() => pending.delete(url));
		pending.set(url, load);
	}
	return load;
};
