/**
 * OpenLayers adapter for omProtocol.
 *
 * OpenLayers has no custom-protocol mechanism. This module provides
 * `addOpenLayersProtocolSupport`, which creates:
 *
 *   - `createRasterSource(tileJsonUrl, options?)` — an `ol.source.DataTile`
 *     whose async `loader` calls the registered protocol handler and returns
 *     the `ImageBitmap` directly to OL.  No PNG encode/decode cycle.
 *     Use with `new ol.layer.WebGLTile({ source })`.
 *
 *   - `createVectorTileSource(tileJsonUrl, options?)` — an `ol.source.VectorTile`
 *     that fetches PBF bytes through the protocol handler, converts them to
 *     a blob URL, and feeds them to OL's native MVT pipeline for true vector
 *     rendering.  Use with `new ol.layer.VectorTile({ source, style })`.
 *
 * Both sources are created synchronously. The TileJSON is resolved lazily on
 * the first tile load, so the map can be set up before the protocol resolves.
 *
 * Usage:
 *
 * ```ts
 * import { omProtocol, addOpenLayersProtocolSupport } from '@openmeteo/weather-map-layer';
 *
 * // 1. Create the adapter, passing the OpenLayers global.
 * const olAdapter = addOpenLayersProtocolSupport(ol);
 *
 * // 2. Register your protocol handler.
 * olAdapter.addProtocol('om', omProtocol);
 *
 * // 3. Create sources — synchronous, TileJSON resolved on first tile load.
 * const rasterSource = olAdapter.createRasterSource('om://' + omUrl);
 * const vectorSource = olAdapter.createVectorTileSource('om://' + omUrl + '&arrows=true');
 *
 * // 4. Add to the map.
 * new ol.Map({
 *   target: 'map',
 *   layers: [
 *     new ol.layer.WebGLTile({ source: rasterSource, opacity: 0.75 }),
 *     new ol.layer.VectorTile({ source: vectorSource }),
 *   ],
 *   view: new ol.View({ center: ol.proj.fromLonLat([10, 50]), zoom: 5 }),
 * });
 * ```
 */
import { buildTileUrl, createProtocolRegistry, extractProtocol } from './helpers';

import { ProtocolAdapter } from './types';

/* ── Minimal OpenLayers type surface used by this adapter ────────────── */

/** Tile grid with extent lookup (ol.tilegrid.TileGrid). */
interface OlTileGrid {
	getTileCoordExtent(tileCoord: number[]): number[];
}

/** MVT format instance (ol.format.MVT). */
interface OlMVTFormat {
	readFeatures(
		source: unknown,
		options: { extent: number[]; featureProjection: unknown }
	): unknown[];
	readProjection(source: unknown): unknown;
}

/** Common surface shared by DataTile and VectorTile sources. */
interface OlSourceBase {
	setAttributions(attributions: string): void;
}

/** ol.source.VectorTile instance (only the properties this adapter uses). */
interface OlVectorTileSource extends OlSourceBase {
	getTileGrid(): OlTileGrid;
	getProjection(): unknown;
	on(event: 'tileloaderror', listener: (evt: { tile: OlVectorTileTile }) => void): void;
	on(event: 'clear', listener: () => void): void;
}

/** A single OL vector tile object passed to tileLoadFunction. */
interface OlVectorTileTile {
	getTileCoord(): number[];
	setFeatures(features: unknown[]): void;
	onLoad(features: unknown[], projection: unknown): void;
	setState(state: number): void;
	/** Returns the tile's current state (0=IDLE, 1=LOADING, 2=LOADED, 3=ERROR, 4=EMPTY, 5=ABORT). */
	getState(): number;
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
}

/** The subset of the OpenLayers namespace this adapter consumes. */
export interface OlLib {
	source: {
		DataTile: new (options: Record<string, unknown>) => OlSourceBase;
		VectorTile: new (options: Record<string, unknown>) => OlVectorTileSource;
	};
	format?: {
		MVT: new () => OlMVTFormat;
	};
}

/**
 * The object returned by `addOpenLayersProtocolSupport`.
 */
export interface OpenLayersProtocolAdapter extends ProtocolAdapter {
	/**
	 * Create a raster tile source backed by the registered protocol handler.
	 *
	 * Returns an `ol.source.DataTile` whose async `loader` fetches each tile
	 * through omProtocol and returns the `ImageBitmap` directly to OL — no PNG
	 * encode/decode roundtrip.  Use with `new ol.layer.WebGLTile({ source })`.
	 *
	 * @param tileJsonUrl - The `om://` TileJSON URL.
	 * @param olOptions   - Extra options forwarded to `ol.source.DataTile` constructor.
	 */
	createRasterSource: (tileJsonUrl: string, olOptions?: Record<string, unknown>) => OlSourceBase;

	/**
	 * Create a vector tile source backed by the registered protocol handler.
	 *
	 * Returns an `ol.source.VectorTile` (MVT format) with a custom
	 * `tileLoadFunction` that fetches PBF bytes through omProtocol and
	 * feeds them to OL's native MVT parser via a blob URL.
	 * Use with `new ol.layer.VectorTile({ source, style })`.
	 *
	 * @param tileJsonUrl - The `om://` TileJSON URL.
	 * @param olOptions   - Extra options forwarded to `ol.source.VectorTile`.
	 */
	createVectorTileSource: (
		tileJsonUrl: string,
		olOptions?: Record<string, unknown>
	) => OlVectorTileSource;
}

/**
 * Adds custom protocol support to OpenLayers.
 *
 * @param ol - The OpenLayers global object (or a subset with
 *             `{ source: { DataTile, VectorTile }, format: { MVT } }`).
 * @returns An `OpenLayersProtocolAdapter` with `addProtocol`, `removeProtocol`,
 *          `createRasterSource`, and `createVectorTileSource`.
 */
export const addOpenLayersProtocolSupport = (ol: OlLib): OpenLayersProtocolAdapter => {
	if (!ol?.source?.DataTile || !ol?.source?.VectorTile) {
		throw new Error(
			'[openlayers-adapter] ol.source.DataTile and ol.source.VectorTile must be available. ' +
				'Only the latest OpenLayers version is supported.'
		);
	}

	const registry = createProtocolRegistry('openlayers-adapter');

	return {
		addProtocol: (protocol, handler, settings) => {
			registry.add(protocol, handler, settings);
		},
		removeProtocol: (protocol) => {
			registry.remove(protocol);
		},

		createRasterSource: (tileJsonUrl, olOptions = {}) => {
			const resolve = registry.makeTileJsonResolver(tileJsonUrl);

			// Track in-flight AbortControllers per tile key for cancellation.
			const inflight = new Map<string, AbortController>();
			let attributionSet = false;

			const source = new ol.source.DataTile({
				/**
				 * OL calls this for every visible tile.  TileJSON is resolved lazily on
				 * the first call; attribution is set once resolved.
				 *
				 * We return `ImageBitmap` directly — OL's DataTile + WebGLTile pipeline
				 * accepts it natively and uploads it to the GPU without re-encoding.
				 *
				 * Latest OL always provides `{signal}` which fires when OL cancels
				 * the tile (e.g. evicted from cache while still loading).
				 */
				loader: async (z: number, x: number, y: number, { signal }: { signal: AbortSignal }) => {
					const tileKey = `${z}/${x}/${y}`;

					// Abort any in-flight request for the same tile key, and proactively abort
					// all tiles from a different zoom level — once OL starts loading tiles for
					// zoom z those tiles are guaranteed stale (previous zoom level).
					for (const [key, ctrl] of inflight) {
						if (key === tileKey || parseInt(key) !== z) {
							ctrl.abort();
							inflight.delete(key);
						}
					}

					const abortController = new AbortController();
					inflight.set(tileKey, abortController);

					// Forward OL's abort signal to our controller so the handler's
					// network fetch is cancelled when OL cancels the tile.
					if (signal.aborted) {
						abortController.abort();
					} else {
						signal.addEventListener('abort', () => abortController.abort(), { once: true });
					}

					try {
						const { tileTemplate, tileJson } = await resolve();

						if (abortController.signal.aborted) {
							throw new DOMException('Aborted', 'AbortError');
						}

						// Update source metadata once on first successful TileJSON fetch.
						if (tileJson['attribution'] && !attributionSet) {
							attributionSet = true;
							source.setAttributions(tileJson['attribution'] as string);
						}

						const url = buildTileUrl(tileTemplate, z, x, y);
						const tileProtocol = extractProtocol(url) ?? extractProtocol(tileJsonUrl)!;
						const { handler, settings } = registry.get(tileProtocol);

						const response = await handler({ url, type: 'image' }, abortController, settings);
						const data = response?.data;

						if (abortController.signal.aborted) {
							throw new DOMException('Aborted', 'AbortError');
						}

						if (!data) {
							// Empty tile — return a transparent 1×1 pixel so OL marks it LOADED.
							return new ImageData(1, 1);
						}

						if (data instanceof ImageBitmap) {
							// Fast path: hand ImageBitmap directly to OL's WebGL pipeline.
							return data;
						}

						throw new Error(
							`[openlayers-adapter] Unsupported raster tile data type: ${Object.prototype.toString.call(data)}`
						);
					} finally {
						// Guard: only remove our entry — a newer request may have replaced it.
						if (inflight.get(tileKey) === abortController) {
							inflight.delete(tileKey);
						}
					}
				},
				wrapX: true,
				tileSize: 256,
				...olOptions
			});

			// Eagerly kick off TileJSON resolution so the first tiles don't
			// have to wait for it. This prefetch is best-effort: tile loaders
			// will surface real errors to callers when tiles are requested.
			Promise.resolve()
				.then(() => resolve())
				.then(({ tileJson }) => {
					if (tileJson['attribution']) {
						source.setAttributions(tileJson['attribution'] as string);
					}
				})
				.catch(() => {});

			return source;
		},

		createVectorTileSource: (tileJsonUrl, olOptions = {}) => {
			if (!ol.format?.MVT) {
				throw new Error(
					'[openlayers-adapter] ol.format.MVT is not available. ' +
						'Make sure the full OpenLayers bundle is loaded.'
				);
			}

			const resolve = registry.makeTileJsonResolver(tileJsonUrl);
			const baseProtocol = extractProtocol(tileJsonUrl)!;
			const format = (olOptions['format'] as OlMVTFormat | undefined) ?? new ol.format.MVT();
			const { format: _unusedFormat, ...restOlOptions } = olOptions;

			// Track in-flight AbortControllers per tile key for cancellation.
			const inflight = new Map<string, AbortController>();

			const source = new ol.source.VectorTile({
				format,

				// A placeholder URL with {z}/{x}/{y} is required so OL enters
				// its tile-loading pipeline for every tile coordinate.
				url: 'om://placeholder/{z}/{x}/{y}',

				/**
				 * Custom tile load function:
				 *
				 * 1. Fetch PBF bytes through omProtocol.
				 * 2. Parse them with ol.format.MVT.readFeatures().
				 * 3. Hand the features to tile.onLoad() for native OL
				 *    vector rendering (projection, styling, hit-detection).
				 */
				tileLoadFunction: (tile: OlVectorTileTile, _placeholderUrl: string) => {
					const tileCoord = tile.getTileCoord();
					const [z, x, y] = tileCoord;
					const tileKey = `${z}/${x}/${y}`;

					// Abort any in-flight request for the same tile key, and proactively abort
					// all tiles from a different zoom level — once OL starts loading tiles for
					// zoom z those tiles are guaranteed stale (previous zoom level).
					for (const [key, ctrl] of inflight) {
						if (key === tileKey || parseInt(key) !== z) {
							ctrl.abort();
							inflight.delete(key);
						}
					}

					const abortController = new AbortController();
					inflight.set(tileKey, abortController);

					// In latest OL, when OL explicitly marks this tile EMPTY (4) or
					// ABORT (5), forward that to our controller so the fetch is cancelled.
					const onTileStateChange = () => {
						const state = tile.getState();
						if (state === 4 /* EMPTY */ || state === 5 /* ABORT */) {
							abortController.abort();
							tile.removeEventListener('change', onTileStateChange);
						}
					};
					tile.addEventListener('change', onTileStateChange);

					resolve()
						.then(({ tileTemplate }) => {
							if (abortController.signal.aborted) {
								return;
							}
							const url = buildTileUrl(tileTemplate, z, x, y);
							const tileProtocol = extractProtocol(url) ?? baseProtocol;
							const { handler, settings } = registry.get(tileProtocol);
							return handler({ url, type: 'arrayBuffer' }, abortController, settings);
						})
						.then((response) => {
							if (abortController.signal.aborted) {
								return;
							}

							const data = response?.data;

							// Determine the tile's map-coordinate extent and
							// projection so MVT coordinates are scaled correctly.
							const tileGrid = source.getTileGrid();
							const tileExtent = tileGrid.getTileCoordExtent(tileCoord);
							const projection = source.getProjection() || 'EPSG:3857';

							if (!data || (data instanceof ArrayBuffer && data.byteLength === 0)) {
								// Empty tile — signal no features.
								tile.setFeatures([]);
								return;
							}

							// Parse the PBF with OL's MVT format and hand
							// features to the tile for native vector rendering.
							const features = format.readFeatures(data, {
								extent: tileExtent,
								featureProjection: projection
							});
							const dataProjection = format.readProjection(data);
							tile.onLoad(features, dataProjection);
						})
						.catch((err: unknown) => {
							console.error('[openlayers-adapter] Vector tile error:', err);
							// Signal error state so OL doesn't keep retrying.
							if (!abortController.signal.aborted) {
								tile.setState(3); // TileState.ERROR
							}
						})
						.finally(() => {
							tile.removeEventListener('change', onTileStateChange);
							// Clean up the inflight entry if it still points to this controller.
							if (inflight.get(tileKey) === abortController) {
								inflight.delete(tileKey);
							}
						});
				},

				wrapX: true,
				...restOlOptions
			});

			// When tiles are no longer needed (e.g. zoom change clears the source
			// cache), abort all in-flight requests.
			source.on('tileloaderror', (evt) => {
				const [z2, x2, y2] = evt.tile.getTileCoord();
				const key = `${z2}/${x2}/${y2}`;
				const ctrl = inflight.get(key);
				if (ctrl) {
					ctrl.abort();
					inflight.delete(key);
				}
			});
			source.on('clear', () => {
				for (const controller of inflight.values()) controller.abort();
				inflight.clear();
			});

			// Eagerly kick off TileJSON resolution so the first tiles don't
			// have to wait for it. This prefetch is best-effort: tile loads
			// handle/report actual failures when needed.
			Promise.resolve()
				.then(() => resolve())
				.then(({ tileJson }) => {
					if (tileJson['attribution']) {
						source.setAttributions(tileJson['attribution'] as string);
					}
				})
				.catch(() => {});

			return source;
		}
	};
};
