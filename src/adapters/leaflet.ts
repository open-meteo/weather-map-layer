/**
 * Leaflet adapter for omProtocol.
 *
 * Leaflet has no custom-protocol mechanism and no native vector tile support.
 * This module provides `addLeafletProtocolSupport`, which creates:
 *
 *   - `createTileLayer(tileJsonUrl, options?)` — an `L.GridLayer` whose
 *     `createTile` calls the registered protocol handler and draws the
 *     returned `ImageBitmap` directly onto a `<canvas>` tile element.
 *     No extra PNG encode/decode cycle.
 *
 *   - `createVectorTileLayer(tileJsonUrl, options?)` — an `L.GridLayer` whose
 *     `createTile` fetches PBF bytes through the protocol handler, decodes
 *     the MVT features, and renders them onto a `<canvas>` tile using a
 *     configurable style function.
 *
 * Both layers are created synchronously. The TileJSON is resolved lazily on
 * the first tile load, so the map can be set up before the protocol resolves.
 *
 * Usage:
 *
 * ```ts
 * import L from 'leaflet';
 * import { omProtocol, addLeafletProtocolSupport } from '@openmeteo/weather-map-layer';
 *
 * // 1. Create the adapter, passing the Leaflet global.
 * const leafletAdapter = addLeafletProtocolSupport(L);
 *
 * // 2. Register your protocol handler (same signature as MapLibre's addProtocol).
 * leafletAdapter.addProtocol('om', omProtocol);
 *
 * // 3. Create the map with a standard base layer.
 * const map = L.map('map').setView([50, 10], 5);
 *
 * // 4. Create layers — synchronous, TileJSON resolved on first tile load.
 * const rasterLayer = leafletAdapter.createTileLayer('om://' + omUrl, { opacity: 0.75 });
 * const vectorLayer = leafletAdapter.createVectorTileLayer('om://' + omUrl + '&arrows=true');
 *
 * rasterLayer.addTo(map);
 * vectorLayer.addTo(map);
 * ```
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import {
	type CanvasVectorStyle,
	type CanvasVectorStyleFn,
	defaultVectorStyle,
	extractRenderFeatures
} from './canvas-vector';
import { buildTileUrl, createProtocolRegistry, extractProtocol } from './helpers';
import { renderInWorker } from './leaflet-worker/leaflet-pbf-worker-pool';

import { ProtocolAdapter } from './types';

/**
 * Tile coordinates passed to `createTile` and stored in `GridLayer._tiles`.
 * A Leaflet `Point` (`{x, y}`) with `z` (zoom) added at runtime.
 */
interface LeafletCoords {
	x: number;
	y: number;
	z: number;
}

/**
 * Entry in the `_tiles` cache maintained by `GridLayer`.
 * See: https://github.com/Leaflet/Leaflet/blob/main/src/layer/tile/GridLayer.js
 */
interface LeafletInternalTile {
	/** The element returned by `createTile` (e.g. `<canvas>` or `<img>`). */
	el: HTMLElement;
	/** Tile coordinates including zoom level. */
	coords: LeafletCoords;
	/** Whether the tile is inside the current viewport. */
	current: boolean;
	/** Unix timestamp (ms) set when the tile finishes loading. */
	loaded?: number;
	/** Set to `true` once the fade-in animation completes. */
	active?: boolean;
	/** Whether to keep the tile during a prune pass. */
	retain?: boolean;
}

/** Leaflet GridLayer instance (only the properties this adapter uses). */
interface LeafletGridLayerInstance {
	options: { zoomOffset?: number };
	getTileSize(): { x: number; y: number };
	/** Internal tile cache keyed by `"x:y:z"`. */
	_tiles: Record<string, LeafletInternalTile>;
	/** The zoom level currently being rendered, or `undefined` when out of range. */
	_tileZoom: number | undefined;
	/** Fire a Leaflet event on this layer (from `Layer`). */
	fire(event: string, data?: Record<string, unknown>): this;
}

/** The subset of the Leaflet namespace this adapter consumes. */
export interface LeafletLib {
	GridLayer: {
		extend(
			proto: Record<string, unknown>
		): new (options: Record<string, unknown>) => LeafletGridLayerInstance;
		prototype: {
			_removeTile(this: unknown, key: string): void;
			_abortLoading(this: unknown): void;
		};
	};
}

export type LeafletVectorStyle = CanvasVectorStyle;
export type LeafletVectorStyleFn = CanvasVectorStyleFn;

/**
 * Options accepted by `createVectorTileLayer`, extending Leaflet GridLayer options.
 */
export interface VectorTileLayerOptions {
	/** Style function called for each feature. */
	style?: LeafletVectorStyleFn;
	/** Extra options forwarded to L.GridLayer. */
	[key: string]: unknown;
}

/**
 * The object returned by `addLeafletProtocolSupport`.
 */
export interface LeafletProtocolAdapter extends ProtocolAdapter {
	/**
	 * Create a raster tile layer backed by the registered protocol handler.
	 *
	 * Returns an `L.GridLayer` whose `createTile` fetches each tile through
	 * omProtocol and draws the `ImageBitmap` directly onto a canvas element —
	 * no redundant PNG encode/decode step.
	 *
	 * @param tileJsonUrl   - The `om://` TileJSON URL.
	 * @param leafletOptions - Extra options forwarded to `L.GridLayer`.
	 */
	createTileLayer: (
		tileJsonUrl: string,
		leafletOptions?: Record<string, unknown>
	) => LeafletGridLayerInstance;

	/**
	 * Create a vector tile layer backed by the registered protocol handler.
	 *
	 * Returns an `L.GridLayer` that fetches PBF bytes through omProtocol,
	 * decodes MVT features, and renders them on a canvas tile.
	 * Suitable for wind arrows, contour lines, grid points, etc.
	 *
	 * @param tileJsonUrl   - The `om://` TileJSON URL.
	 * @param options        - Style function and extra `L.GridLayer` options.
	 */
	createVectorTileLayer: (
		tileJsonUrl: string,
		options?: VectorTileLayerOptions
	) => LeafletGridLayerInstance;
}

/**
 * The protocol renders 512 px tiles and sizes its arrow/barb lattice for
 * them, as MapLibre requests. Leaflet's native 256 px tiles would fetch a
 * zoom level deeper for the same view, giving twice the vector density and
 * four times the raster work; 512 px tiles one zoom level up reproduce the
 * MapLibre look 1:1.
 */
const TILE_LAYER_DEFAULTS = { tileSize: 512, zoomOffset: -1, crossOrigin: true };

/**
 * Zoom level to request for a tile. `zoomOffset` is a `TileLayer` option that
 * `GridLayer` does not apply itself: `coords.z` is always the map zoom, so a
 * 512 px layer has to shift it here, exactly as `TileLayer._getZoomForUrl`.
 */
const urlZoom = (layer: LeafletGridLayerInstance, coords: LeafletCoords): number =>
	coords.z + (layer.options.zoomOffset ?? 0);

/**
 * Adds custom protocol support to Leaflet.
 *
 * @param L - The Leaflet global object (`import L from 'leaflet'` or `window.L`).
 * @returns A `LeafletProtocolAdapter` with `addProtocol`, `removeProtocol`,
 *          `createTileLayer`, and `createVectorTileLayer`.
 */
export const addLeafletProtocolSupport = (L: LeafletLib): LeafletProtocolAdapter => {
	if (!L?.GridLayer) {
		throw new Error(
			'[leaflet-adapter] L.GridLayer is not available. ' +
				'Make sure Leaflet is fully loaded before calling addLeafletProtocolSupport().'
		);
	}

	const registry = createProtocolRegistry('leaflet-adapter');

	return {
		addProtocol: (protocol, handler, settings) => {
			registry.add(protocol, handler, settings);
		},
		removeProtocol: (protocol) => {
			registry.remove(protocol);
		},

		createTileLayer: (tileJsonUrl, leafletOptions = {}) => {
			const resolve = registry.makeTileJsonResolver(tileJsonUrl);

			// Track in-flight AbortControllers per tile key for cancellation.
			const inflight = new Map<string, AbortController>();

			const OmRasterGridLayer = L.GridLayer.extend({
				createTile(
					this: LeafletGridLayerInstance,
					coords: LeafletCoords,
					done: (error: Error | null, tile: HTMLElement) => void
				): HTMLCanvasElement {
					const tileSize: number = this.getTileSize().x;
					const canvas = document.createElement('canvas') as HTMLCanvasElement;
					canvas.width = tileSize;
					canvas.height = tileSize;

					const tileKey = `${coords.z}/${coords.x}/${coords.y}`;
					const abortController = new AbortController();
					inflight.set(tileKey, abortController);

					resolve()
						.then(({ tileTemplate }) => {
							if (abortController.signal.aborted) return;

							const url = buildTileUrl(tileTemplate, urlZoom(this, coords), coords.x, coords.y);
							const tileProtocol = extractProtocol(url) ?? extractProtocol(tileJsonUrl)!;
							const { handler, settings } = registry.get(tileProtocol);

							return handler({ url, type: 'image' }, abortController, settings);
						})
						.then((response) => {
							if (!response || abortController.signal.aborted) {
								done(null, canvas);
								return;
							}

							const data = response.data;
							if (!data || (data instanceof ArrayBuffer && data.byteLength === 0)) {
								// Empty tile — return blank canvas.
								done(null, canvas);
								return;
							}

							if (data instanceof ImageBitmap) {
								const ctx = canvas.getContext('2d');
								if (ctx) {
									ctx.drawImage(data, 0, 0, tileSize, tileSize);
								}
								done(null, canvas);
								return;
							}

							done(
								new Error(
									`[leaflet-adapter] Unsupported raster tile data type: ${Object.prototype.toString.call(data)}`
								),
								canvas
							);
						})
						.catch((err) => {
							if (err.name !== 'AbortError' && !abortController.signal.aborted) {
								console.error('[leaflet-adapter] Raster tile error:', err);
								done(err, canvas);
							} else {
								done(null, canvas);
							}
						})
						.finally(() => {
							inflight.delete(tileKey);
						});

					return canvas;
				},

				_removeTile(this: LeafletGridLayerInstance, key: string) {
					// Leaflet's internal key format is "x:y:z"; our inflight map uses "z/x/y".
					const parts = key.split(':');
					if (parts.length === 3) {
						const inflightKey = `${parts[2]}/${parts[0]}/${parts[1]}`;
						const controller = inflight.get(inflightKey);
						if (controller) {
							controller.abort();
							inflight.delete(inflightKey);
						}
					}
					L.GridLayer.prototype._removeTile.call(this, key);
				},

				// Abort in-flight requests for tiles that are no longer at the current zoom level.
				_abortLoading(this: LeafletGridLayerInstance) {
					for (const [, entry] of Object.entries(this._tiles)) {
						if (entry.coords.z !== this._tileZoom) {
							const { el: tile, coords } = entry;
							const key = `${coords.z}/${coords.x}/${coords.y}`;
							if (inflight.has(key)) {
								inflight.get(key)!.abort();
								inflight.delete(key);
								// @event tileabort: TileEvent
								// Fired when a tile was loading but is now not wanted.
								this.fire('tileabort', { tile, coords });
							}
						}
					}
				}
			});

			return new OmRasterGridLayer({
				...TILE_LAYER_DEFAULTS,
				...leafletOptions
			});
		},

		createVectorTileLayer(tileJsonUrl, options = {}) {
			const { style: userStyle, ...restOptions } = options;
			const styleFn: LeafletVectorStyleFn =
				(userStyle as LeafletVectorStyleFn) ?? defaultVectorStyle;
			const resolve = registry.makeTileJsonResolver(tileJsonUrl);

			// Track in-flight AbortControllers per tile key for cancellation.
			const inflight = new Map<string, AbortController>();

			const OmVectorGridLayer = L.GridLayer.extend({
				createTile(
					this: LeafletGridLayerInstance,
					coords: LeafletCoords,
					done: (error: Error | null, tile: HTMLElement) => void
				): HTMLCanvasElement {
					const tileSize: number = this.getTileSize().x;
					const canvas = document.createElement('canvas') as HTMLCanvasElement;
					canvas.width = tileSize;
					canvas.height = tileSize;

					const tileKey = `${coords.z}/${coords.x}/${coords.y}`;
					const abortController = new AbortController();
					inflight.set(tileKey, abortController);

					resolve()
						.then(({ tileTemplate }) => {
							if (abortController.signal.aborted) return;

							const url = buildTileUrl(tileTemplate, urlZoom(this, coords), coords.x, coords.y);
							const tileProtocol = extractProtocol(url) ?? extractProtocol(tileJsonUrl)!;
							const { handler, settings } = registry.get(tileProtocol);

							return handler({ url, type: 'arrayBuffer' }, abortController, settings);
						})
						.then((response) => {
							if (!response || abortController.signal.aborted) {
								done(null, canvas);
								return;
							}

							const data = response.data;
							if (!data || (data instanceof ArrayBuffer && data.byteLength === 0)) {
								// Empty tile — return blank canvas.
								done(null, canvas);
								return;
							}

							// Decode MVT features from PBF bytes.
							const pbfData = new PbfReader(data as ArrayBuffer);
							const vectorTile = new VectorTile(pbfData);
							const extracted = extractRenderFeatures(vectorTile, tileSize, styleFn);

							renderInWorker(tileSize, extracted)
								.then((bitmap) => {
									if (bitmap && !abortController.signal.aborted) {
										const ctx = canvas.getContext('2d');
										if (ctx) {
											ctx.drawImage(bitmap, 0, 0);
										}
									}
									done(null, canvas);
								})
								.catch((err) => {
									if (!abortController.signal.aborted) {
										console.error('[leaflet-adapter] Worker render error:', err);
									}
									done(null, canvas);
								});
							return; // done() called in the worker callback
						})
						.catch((err) => {
							if (err.name !== 'AbortError' && !abortController.signal.aborted) {
								console.error('[leaflet-adapter] Vector tile error:', err);
								done(err, canvas);
							} else {
								done(null, canvas);
							}
						})
						.finally(() => {
							inflight.delete(tileKey);
						});

					return canvas;
				},

				_removeTile(this: LeafletGridLayerInstance, key: string) {
					// Leaflet's internal key format is "x:y:z"; our inflight map uses "z/x/y".
					const parts = key.split(':');
					if (parts.length === 3) {
						const inflightKey = `${parts[2]}/${parts[0]}/${parts[1]}`;
						const controller = inflight.get(inflightKey);
						if (controller) {
							controller.abort();
							inflight.delete(inflightKey);
						}
					}
					L.GridLayer.prototype._removeTile.call(this, key);
				},

				// Abort in-flight requests for tiles that are no longer at the current zoom level.
				_abortLoading(this: LeafletGridLayerInstance) {
					for (const [, entry] of Object.entries(this._tiles)) {
						if (entry.coords.z !== this._tileZoom) {
							const { el: tile, coords } = entry;
							const key = `${coords.z}/${coords.x}/${coords.y}`;
							if (inflight.has(key)) {
								inflight.get(key)!.abort();
								inflight.delete(key);
								// @event tileabort: TileEvent
								// Fired when a tile was loading but is now not wanted.
								this.fire('tileabort', { tile, coords });
							}
						}
					}
				}
			});

			return new OmVectorGridLayer({
				...TILE_LAYER_DEFAULTS,
				...restOptions
			});
		}
	};
};
