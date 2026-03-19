/**
 * Mapbox GL JS adapter for omProtocol.
 *
 * Mapbox GL JS does not support custom protocols (unlike MapLibre's addProtocol).
 * This module provides `addMapboxProtocolSupport`, which shims that capability by
 * creating a custom raster source type that intercepts tile and TileJSON requests
 * matching a registered protocol prefix (e.g. "om://").
 *
 * Usage:
 *
 * ```ts
 * import mapboxgl from 'mapbox-gl';
 * import { omProtocol, addMapboxProtocolSupport } from '@openmeteo/mapbox-layer';
 *
 * // 1. Create the adapter (before or after creating the map).
 * const adapter = addMapboxProtocolSupport(mapboxgl);
 *
 * // 2. Register your protocol handler (same signature as MapLibre's addProtocol).
 * adapter.addProtocol('om', omProtocol);
 *
 * // 3. Create the map.
 * const map = new mapboxgl.Map({ container: 'map', ... });
 *
 * // 4. Register the custom source type with the map instance.
 * //    Use the name you like; just keep it consistent with step 5.
 * map.addSourceType('raster-om', adapter.sourceType, (err) => {
 *   if (err) console.error('Failed to register raster-om source type', err);
 * });
 *
 * // 5. Add a source using that type and the custom protocol URL.
 * map.on('load', () => {
 *   map.addSource('weather', { type: 'raster-om', url: 'om://...', maxzoom: 12 });
 *   map.addLayer({ id: 'weather-layer', type: 'raster', source: 'weather' });
 * });
 * ```
 */
import { createProtocolRegistry, extractProtocol } from './helpers';

import { ProtocolAdapter } from './types';

/** Minimal representation of a Mapbox tile object passed to loadTile(). */
interface MapboxTile {
	tileID: {
		canonical: {
			url: (tiles: string[], scheme: string) => string;
		};
	};
	state: string;
	request?: { cancel: () => void };
}

/** Minimal interface for Mapbox tile source instances (raster or vector). */
interface MapboxSourceInstance {
	_options?: Record<string, unknown>;
	options?: Record<string, unknown>;
	url?: string;
	tiles?: string[];
	scheme?: string;
	fire?(event: string, data?: unknown): void;
	load(): void;
	loadTile(tile: MapboxTile, callback: (err?: Error | null) => void): void;
}

/** Constructor type for dynamically-obtained Mapbox source classes. */
type MapboxSourceConstructor = new (...args: unknown[]) => MapboxSourceInstance;

/** The subset of the Mapbox GL JS namespace this adapter consumes. */
export interface MapboxLib {
	Style: {
		getSourceType(type: 'raster' | 'vector'): MapboxSourceConstructor;
	};
}

/**
 * The object returned by `addMapboxProtocolSupport`.
 */
export interface MapboxProtocolAdapter extends ProtocolAdapter {
	/**
	 * Custom raster source class – pass to `map.addSourceType('raster-om', adapter.rasterSourceType, cb)`.
	 */
	rasterSourceType: MapboxSourceConstructor;

	/**
	 * Custom vector source class – pass to `map.addSourceType('vector-om', adapter.vectorSourceType, cb)`.
	 * Required for vector tile layers (arrows, contours, grids, …).
	 */
	vectorSourceType: MapboxSourceConstructor;
}

/**
 * Convert the data returned by a protocol handler into an object URL that
 * Mapbox can load as an image tile.
 *
 * Prefers `OffscreenCanvas` when available to avoid DOM canvas creation
 * overhead (no layout, no GC of DOM nodes).
 */
const dataToObjectUrl = async (data: unknown): Promise<string> => {
	if (data instanceof ImageBitmap) {
		// Prefer OffscreenCanvas for ImageBitmap → Blob conversion (no DOM overhead).
		if (typeof OffscreenCanvas !== 'undefined') {
			const oc = new OffscreenCanvas(data.width, data.height);
			const ctx = oc.getContext('2d');
			if (!ctx) {
				throw new Error('[mapbox-adapter] Could not obtain OffscreenCanvas 2D context');
			}
			ctx.drawImage(data, 0, 0);
			const blob = await oc.convertToBlob({ type: 'image/png' });
			return URL.createObjectURL(blob);
		}
	}

	if (data instanceof ArrayBuffer) {
		// Treat the raw bytes as an encoded image (PNG/WebP as returned by omProtocol).
		const blob = new Blob([new Uint8Array(data)], { type: 'image/png' });
		return URL.createObjectURL(blob);
	}

	throw new Error(
		`[mapbox-adapter] Unsupported tile data type: ${Object.prototype.toString.call(data)}`
	);
};

/**
 * Adds custom protocol support to Mapbox GL JS.
 *
 * Mapbox does not have a built-in `addProtocol` API, so this function works
 * around that limitation by creating a custom raster source type whose
 * `load()` (TileJSON fetch) and `loadTile()` (individual tile fetch) methods
 * are overridden to call registered protocol handlers instead of making real
 * HTTP requests.
 *
 * @param mapboxgl - The Mapbox GL JS library object (`import mapboxgl from 'mapbox-gl'`).
 * @returns A `MapboxProtocolAdapter` containing `addProtocol`, `removeProtocol`, `rasterSourceType`, and `vectorSourceType`.
 *
 * @throws If `mapboxgl.Style` is not available (i.e., the library is not fully
 *         loaded when this function is called).
 */
export const addMapboxProtocolSupport = (mapboxgl: MapboxLib): MapboxProtocolAdapter => {
	if (!mapboxgl?.Style?.getSourceType) {
		throw new Error(
			'[mapbox-adapter] mapboxgl.Style.getSourceType is not available. ' +
				'Make sure the Mapbox GL JS library is fully loaded before calling addMapboxProtocolSupport().'
		);
	}

	const registry = createProtocolRegistry('mapbox-adapter');

	/**
	 * Shared `load()` override for both raster and vector source subclasses.
	 *
	 * Mapbox's source `load()` internally calls `loadTileJSON(this._options, …)` which
	 * immediately HTTP-fetches `this._options.url`.  For custom-protocol URLs we:
	 *   1. Call the registered handler ourselves to get the TileJSON.
	 *   2. Patch `this._options` in-place: remove `url`, inject `tiles` + metadata.
	 *   3. Call `super.load()` – now `loadTileJSON` sees no URL, uses `tiles` directly.
	 */
	function omLoad(this: MapboxSourceInstance, superLoad: () => void): void {
		const optionsObj: Record<string, unknown> | undefined = this._options ?? this.options;
		const originalUrl: string | undefined =
			(optionsObj?.['url'] as string) ?? (this.url as string | undefined);

		const protocol = originalUrl ? extractProtocol(originalUrl) : null;
		if (!protocol) {
			superLoad.call(this);
			return;
		}
		if (!registry.has(protocol)) {
			const err = new Error(`[mapbox-adapter] No handler registered for protocol: "${protocol}"`);
			console.error(err.message);
			this.fire?.('error', { error: err });
			return;
		}

		const { handler, settings } = registry.get(protocol);
		const abortController = new AbortController();

		handler({ url: originalUrl, type: 'json' }, abortController, settings)
			.then((response) => {
				if (!response?.data) {
					throw new Error(
						`[mapbox-adapter] Protocol handler returned no data for TileJSON: ${originalUrl}`
					);
				}

				const tileJson = response.data as Record<string, unknown>;

				if (optionsObj) {
					delete optionsObj['url'];
					optionsObj['tiles'] = tileJson['tiles'];
					if (tileJson['bounds'] != null) optionsObj['bounds'] = tileJson['bounds'];
					if (tileJson['minzoom'] != null) optionsObj['minzoom'] = tileJson['minzoom'];
					if (tileJson['maxzoom'] != null) optionsObj['maxzoom'] = tileJson['maxzoom'];
					if (tileJson['attribution'] != null) optionsObj['attribution'] = tileJson['attribution'];
					if (tileJson['scheme'] != null) optionsObj['scheme'] = tileJson['scheme'];
				}
				this.url = undefined;

				superLoad.call(this);
			})
			.catch((err: Error) => {
				console.error('[mapbox-adapter] Error fetching TileJSON:', err);
				this.fire?.('error', { error: err });
			});
	}

	const RasterTileSource = mapboxgl.Style.getSourceType('raster');

	class OmRasterSource extends RasterTileSource {
		constructor(...args: unknown[]) {
			super(...args);
		}

		load() {
			omLoad.call(this, super.load);
		}

		/**
		 * Override `loadTile()` to intercept individual tile requests for custom protocols.
		 *
		 * When the tile URL starts with a registered protocol, we call the handler
		 * with `type: 'image'`, convert the returned ImageBitmap / ArrayBuffer into
		 * a Blob URL, and delegate to the parent `loadTile()` with that Blob URL so
		 * that Mapbox can decode and display the tile normally.
		 */
		loadTile(tile: MapboxTile, callback: (err?: Error | null) => void): void {
			// Reconstruct the tile URL from the tile coordinate and the source's tile templates.
			const rawUrl: string =
				typeof tile.tileID?.canonical?.url === 'function'
					? tile.tileID.canonical.url(this.tiles ?? [], this.scheme ?? 'xyz')
					: '';

			const protocol = rawUrl ? extractProtocol(rawUrl) : null;
			if (!protocol) {
				super.loadTile(tile, callback);
				return;
			}
			if (!registry.has(protocol)) {
				callback(new Error(`[mapbox-adapter] No handler registered for protocol: "${protocol}"`));
				return;
			}

			const { handler, settings } = registry.get(protocol);
			const abortController = new AbortController();

			// Expose cancellation so Mapbox can abort in-flight tile requests.
			tile.request = { cancel: () => abortController.abort() };

			handler(
				{ url: rawUrl, type: 'image', headers: { accept: 'image/webp,*/*' } },
				abortController,
				settings
			)
				.then(async (response) => {
					if (abortController.signal.aborted) {
						tile.state = 'unloaded';
						callback(null);
						return;
					}

					if (!response?.data) {
						// Empty / null response – treat as an empty tile rather than an error.
						tile.state = 'loaded';
						callback(null);
						return;
					}

					let objectUrl: string;
					try {
						objectUrl = await dataToObjectUrl(response.data);
					} catch (convErr) {
						callback(convErr instanceof Error ? convErr : new Error(String(convErr)));
						return;
					}

					// Temporarily patch tile.tileID.canonical.url so the parent's
					// loadTile picks up the Blob URL instead of the custom-protocol URL.
					// We restore the original function immediately after the parent
					// returns so the canonical URL object is not permanently modified.
					const originalUrlFn = tile.tileID.canonical.url;
					tile.tileID.canonical.url = () => {
						tile.tileID.canonical.url = originalUrlFn;
						return objectUrl;
					};

					super.loadTile(tile, (err?: Error | null) => {
						URL.revokeObjectURL(objectUrl);
						callback(err);
					});
				})
				.catch((err: Error) => {
					if (err.name === 'AbortError' || abortController.signal.aborted) {
						tile.state = 'unloaded';
						callback(null);
					} else {
						callback(err);
					}
				});
		}
	}

	const VectorTileSource = mapboxgl.Style.getSourceType('vector');

	class OmVectorSource extends VectorTileSource {
		constructor(...args: unknown[]) {
			super(...args);
		}

		load() {
			omLoad.call(this, super.load);
		}

		/**
		 * override `loadTile()` for vector (PBF) tiles.
		 *
		 * Mapbox serializes `tile.tileID` (including `tileID.canonical`) via its own
		 * structured-clone mechanism to send to the web worker. Patching
		 * `tileID.canonical.url` with a plain function breaks that serializer
		 * ("can't serialize object of type function").
		 *
		 * Safe approach:
		 *   1. Call the protocol handler ourselves to get the raw PBF ArrayBuffer.
		 *   2. Create a blob URL from the bytes.
		 *   3. Temporarily swap `this.tiles` to `[blobUrl]` – Mapbox's `super.loadTile`
		 *      reads `this.tiles` **synchronously** to build the request URL string
		 *      (`canonical.url(this.tiles, this.scheme)`).  The blob URL has no
		 *      `{z}/{x}/{y}` placeholders so the substitution is a no-op.
		 *   4. Call `super.loadTile()`.  The synchronous part picks up the blob URL and
		 *      ships it to the worker as a plain string – `tileID` is untouched.
		 *   5. Immediately restore `this.tiles`.  JS is single-threaded, so this
		 *      swap-call-restore is atomic relative to any concurrent `loadTile` call.
		 *   6. The worker fetches the blob URL (same-origin blob URLs are reachable
		 *      from workers), parses the PBF, and returns the tile data normally.
		 *   7. Revoke the blob URL in the callback once the worker is done.
		 */
		loadTile(tile: MapboxTile, callback: (err?: Error | null) => void): void {
			const rawUrl: string =
				typeof tile.tileID?.canonical?.url === 'function'
					? tile.tileID.canonical.url(this.tiles ?? [], this.scheme ?? 'xyz')
					: '';

			const protocol = rawUrl ? extractProtocol(rawUrl) : null;
			if (!protocol) {
				super.loadTile(tile, callback);
				return;
			}
			if (!registry.has(protocol)) {
				callback(new Error(`[mapbox-adapter] No handler registered for protocol: "${protocol}"`));
				return;
			}

			const { handler, settings } = registry.get(protocol);
			const abortController = new AbortController();

			tile.request = { cancel: () => abortController.abort() };

			handler({ url: rawUrl, type: 'arrayBuffer' }, abortController, settings)
				.then((response) => {
					if (abortController.signal.aborted) {
						tile.state = 'unloaded';
						callback(null);
						return;
					}

					const bytes = response?.data instanceof ArrayBuffer ? response.data : new Uint8Array(0);
					const blob = new Blob([bytes], { type: 'application/x-protobuf' });
					const objectUrl = URL.createObjectURL(blob);

					// Swap tiles, dispatch (synchronous URL resolution), restore – atomically.
					const savedTiles = this.tiles;
					this.tiles = [objectUrl];
					try {
						super.loadTile(tile, (err?: Error | null) => {
							URL.revokeObjectURL(objectUrl);
							callback(err);
						});
					} finally {
						this.tiles = savedTiles;
					}
				})
				.catch((err: Error) => {
					if (err.name === 'AbortError' || abortController.signal.aborted) {
						tile.state = 'unloaded';
						callback(null);
					} else {
						callback(err);
					}
				});
		}
	}

	return {
		addProtocol: (protocol, handler, settings) => {
			registry.add(protocol, handler, settings);
		},
		removeProtocol: (protocol) => {
			registry.remove(protocol);
		},
		rasterSourceType: OmRasterSource,
		vectorSourceType: OmVectorSource
	};
};
