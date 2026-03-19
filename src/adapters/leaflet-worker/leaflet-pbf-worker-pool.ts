// ── Worker import ───────────────────────────────────────────────────
// @ts-expect-error Vite worker import
import LeafletPbfWorker from './leaflet-pbf-worker?worker&inline';

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
	/** Whether to clip rendering to the tile bounds (arrow-grid layers). */
	clip: boolean;
}

// ── Worker pool ──────────────────────────────────────────────────────

const pending = new Map<
	number,
	{ resolve: (bitmap: ImageBitmap | null) => void; reject: (error: Error) => void }
>();

let pool: Worker[] | null = null;
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

const ensurePool = (): Worker[] => {
	if (pool) return pool;
	const count = Math.min(
		typeof navigator !== 'undefined' && navigator.hardwareConcurrency
			? navigator.hardwareConcurrency
			: 2,
		4
	);
	pool = [];
	for (let i = 0; i < count; i++) {
		const w = new LeafletPbfWorker() as Worker;
		w.onmessage = onWorkerMessage;
		pool.push(w);
	}
	return pool;
};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Render pre-processed features in a web worker.
 * Returns a transferable `ImageBitmap` that can be drawn onto a DOM canvas.
 */
export const renderInWorker = (
	tileSize: number,
	extracted: ExtractedFeatures
): Promise<ImageBitmap | null> => {
	const workers = ensurePool();
	const id = nextId++;
	const worker = workers[nextWorker++ % workers.length];

	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		worker.postMessage({
			type: 'render',
			id,
			tileSize,
			clip: extracted.clip,
			features: extracted.features
		});
	});
};
