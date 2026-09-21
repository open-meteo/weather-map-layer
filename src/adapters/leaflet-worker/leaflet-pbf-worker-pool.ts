/**
 * Web Worker pool for offloading vector tile canvas rendering.
 *
 * The main thread decodes the PBF and resolves styles (keeping library
 * dependencies and user-provided style functions on the main thread), then
 * sends pre-processed feature data (coordinates in pixel space, resolved
 * styles) to a pool of workers.
 *
 * Each worker creates an `OffscreenCanvas`, draws the features, and returns
 * the result as a transferable `ImageBitmap` — zero-copy transfer back to the
 * main thread which draws it onto the DOM canvas with a single `drawImage`.
 */

// ── Types ────────────────────────────────────────────────────────────

/** Pre-processed feature ready for canvas rendering. */
export interface RenderFeature {
	type: 1 | 2 | 3;
	/** Each ring is a flat array of pixel coordinates: [x1, y1, x2, y2, …]. */
	rings: number[][];
	strokeStyle: string;
	lineWidth: number;
	lineCap: string;
	globalAlpha: number;
	fill: boolean;
	pointRadius: number;
}

/** Result from extracting render features from a decoded vector tile. */
export interface ExtractedFeatures {
	features: RenderFeature[];
}

// ── Worker pool ──────────────────────────────────────────────────────

const pending = new Map<
	number,
	{ resolve: (bitmap: ImageBitmap | null) => void; reject: (error: Error) => void }
>();

let pool: Promise<Worker[]> | null = null;
let nextWorker = 0;
let nextId = 0;

const onWorkerMessage = (e: MessageEvent): void => {
	const { id, bitmap } = e.data as { id: number; bitmap: ImageBitmap | null };
	const cb = pending.get(id);
	if (cb) {
		pending.delete(id);
		cb.resolve(bitmap);
	}
};

const ensurePool = (): Promise<Worker[]> => {
	if (pool) return pool;
	// Imported lazily: `?worker&inline` embeds the worker bundle as a string and
	// turns it into a Blob when its module is evaluated, so a static import
	// would ship and instantiate it for every consumer of the library, Leaflet
	// user or not. As a dynamic import it is a separate chunk that only the
	// first Leaflet vector tile pulls in.
	// @ts-expect-error Vite worker import
	const workerModule = import('./leaflet-pbf-worker?worker&inline');
	pool = workerModule.then(({ default: LeafletPbfWorker }) => {
		const count = Math.min(
			typeof navigator !== 'undefined' && navigator.hardwareConcurrency
				? navigator.hardwareConcurrency
				: 2,
			4
		);
		const workers: Worker[] = [];
		for (let i = 0; i < count; i++) {
			const w = new LeafletPbfWorker() as Worker;
			w.onmessage = onWorkerMessage;
			workers.push(w);
		}
		return workers;
	});
	return pool;
};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Render pre-processed features in a web worker.
 * Returns a transferable `ImageBitmap` that can be drawn onto a DOM canvas.
 */
export const renderInWorker = async (
	tileSize: number,
	extracted: ExtractedFeatures
): Promise<ImageBitmap | null> => {
	const workers = await ensurePool();
	const id = nextId++;
	const worker = workers[nextWorker++ % workers.length];

	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		worker.postMessage({
			type: 'render',
			id,
			tileSize,
			features: extracted.features
		});
	});
};
