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
 * import { omProtocol, addLeafletProtocolSupport } from '@openmeteo/mapbox-layer';
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
import Pbf from 'pbf';

import { buildTileUrl, createProtocolRegistry, extractProtocol } from './helpers';
import { renderInWorker } from './leaflet-worker/leaflet-pbf-worker-pool';
import type { ExtractedFeatures, RenderFeature } from './leaflet-worker/leaflet-pbf-worker-pool';

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

/**
 * Style callback for vector tile features drawn on a Leaflet canvas.
 *
 * Return `null` / `undefined` to skip the feature.
 */
export interface LeafletVectorStyle {
	strokeStyle?: string | ((value: number) => string);
	lineWidth?: number | ((value: number) => number);
	lineCap?: CanvasLineCap;
	globalAlpha?: number | ((value: number) => number);
}

export type LeafletVectorStyleFn = (
	properties: Record<string, unknown>,
	layerName: string
) => LeafletVectorStyle | null | undefined;

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

/** The default vector tile extent used by the PBF encoder. */
const VECTOR_TILE_EXTENT = 4096;

/** Default arrow style: semi-transparent dark lines, width based on wind speed. */
const defaultVectorStyle: LeafletVectorStyleFn = (properties) => {
	const value = Number(properties['value']) || 0;
	const alpha = value > 5 ? 0.6 : value > 4 ? 0.5 : value > 3 ? 0.4 : value > 2 ? 0.3 : 0.2;
	const width = value > 10 ? 3.5 : value > 5 ? 3 : 2;
	return {
		strokeStyle: `rgba(0, 0, 0, ${alpha})`,
		lineWidth: width,
		lineCap: 'round'
	};
};

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

	/**
	 * Extract pre-processed features from a decoded MVT.
	 *
	 * Resolves styles via the user's `styleFn` and converts geometry to pixel
	 * coordinates. The result can be passed to the worker or the main-thread
	 * fallback for canvas rendering.
	 */
	const extractRenderFeatures = (
		vectorTile: VectorTile,
		tileSize: number,
		styleFn: LeafletVectorStyleFn
	): ExtractedFeatures => {
		const scale = tileSize / VECTOR_TILE_EXTENT;
		const features: RenderFeature[] = [];
		let clip = false;

		for (const layerName of Object.keys(vectorTile.layers)) {
			const layer = vectorTile.layers[layerName];

			const gridN = Math.round(Math.sqrt(layer.length));
			const isArrowGrid = gridN >= 2 && gridN * gridN === layer.length;
			const cellSize = isArrowGrid ? VECTOR_TILE_EXTENT / gridN : 0;
			if (isArrowGrid) clip = true;

			for (let i = 0; i < layer.length; i++) {
				if (isArrowGrid) {
					const gridRow = Math.floor(i / gridN);
					const gridCol = i % gridN;
					if (gridRow % 2 !== 1 || gridCol % 2 !== 1) continue;
				}

				const feature = layer.feature(i);
				// Inject the MVT layer name as `layer` so style functions can filter by source layer
				const props: Record<string, unknown> = { layer: layerName, ...feature.properties };
				const style = styleFn(props, layerName);
				if (!style) continue;

				const value = Number(props['value']) || 0;

				const strokeStyle =
					typeof style.strokeStyle === 'function'
						? style.strokeStyle(value)
						: (style.strokeStyle ?? 'rgba(0, 0, 0, 0.4)');
				const rawLineWidth =
					typeof style.lineWidth === 'function' ? style.lineWidth(value) : (style.lineWidth ?? 1.5);
				const lineCap = style.lineCap ?? 'round';
				const globalAlpha =
					typeof style.globalAlpha === 'function'
						? style.globalAlpha(value)
						: (style.globalAlpha ?? 1);

				const geometry = feature.loadGeometry();

				const gridRow = isArrowGrid ? Math.floor(i / gridN) : 0;
				const gridCol = isArrowGrid ? i % gridN : 0;
				const centerX = gridCol * cellSize;
				const centerY = gridRow * cellSize;

				let renderType = feature.type;
				// Point
				if (renderType === 1) {
					for (const ring of geometry) {
						if (ring.length > 1) {
							renderType = 2; // LineString
							break;
						}
					}
				}

				const rings: number[][] = [];
				for (const ring of geometry) {
					const coords: number[] = [];
					for (const pt of ring) {
						coords.push(
							isArrowGrid ? ((pt.x - centerX) * 2 + centerX) * scale : pt.x * scale,
							isArrowGrid ? ((pt.y - centerY) * 2 + centerY) * scale : pt.y * scale
						);
					}
					rings.push(coords);
				}

				features.push({
					type: renderType as 1 | 2 | 3,
					rings,
					strokeStyle,
					lineWidth: isArrowGrid ? rawLineWidth * 2 : rawLineWidth,
					lineCap,
					globalAlpha,
					fill: renderType === 3 && !!style.strokeStyle,
					pointRadius: rawLineWidth * 1.5
				});
			}
		}

		return { features, clip };
	};

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

							const url = buildTileUrl(tileTemplate, coords.z, coords.x, coords.y);
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
							if (!data) {
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
				tileSize: 256,
				crossOrigin: true,
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

							const url = buildTileUrl(tileTemplate, coords.z, coords.x, coords.y);
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
							const pbfData = new Pbf(data as ArrayBuffer);
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
				tileSize: 256,
				crossOrigin: true,
				...restOptions
			});
		}
	};
};
