/**
 * Mapbox GL JS adapter for omProtocol.
 *
 * Mapbox GL JS has no custom-protocol mechanism (unlike MapLibre's
 * addProtocol) and, since v3.29, no custom source types either: `Map#addSourceType`
 * was removed in favour of the `CustomSourceInterface`, which only carries
 * raster data. This module provides `addMapboxProtocolSupport`, which creates:
 *
 *   - `createRasterSource(tileJsonUrl, options?)` — a `type: 'custom'` raster
 *     source whose `loadTile` calls the registered protocol handler and hands
 *     the returned `ImageBitmap` straight to Mapbox. Pass it to `map.addSource`.
 *
 *   - `addVectorSource(map, sourceId, tileJsonUrl, options?)` — vector tiles
 *     have no custom-source hook, so they go through a GeoJSON source: the
 *     PBF tiles covering the viewport are fetched through the protocol
 *     handler, decoded, and merged into one FeatureCollection that is refreshed
 *     on every `moveend`. Every feature carries its MVT layer name as a `layer`
 *     property, so style layers select their features with a filter instead of
 *     `source-layer`.
 *
 * Usage:
 *
 * ```ts
 * import mapboxgl from 'mapbox-gl';
 * import { omProtocol, addMapboxProtocolSupport } from '@openmeteo/weather-map-layer';
 *
 * // 1. Create the adapter and register your protocol handler (same signature
 * //    as MapLibre's addProtocol).
 * const adapter = addMapboxProtocolSupport();
 * adapter.addProtocol('om', omProtocol);
 *
 * // 2. Create the map.
 * const map = new mapboxgl.Map({ container: 'map', ... });
 *
 * map.on('load', () => {
 *   // 3. Raster: a custom source, added like any other source.
 *   map.addSource('weather', adapter.createRasterSource('om://...'));
 *   map.addLayer({ id: 'weather-layer', type: 'raster', source: 'weather' });
 *
 *   // 4. Vectors: a GeoJSON source kept in sync with the viewport.
 *   adapter.addVectorSource(map, 'arrows', 'om://...&arrows=true');
 *   map.addLayer({
 *     id: 'arrows-layer',
 *     type: 'line',
 *     source: 'arrows',
 *     filter: ['==', ['get', 'layer'], 'wind-arrows']
 *   });
 * });
 * ```
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import { buildTileUrl, createProtocolRegistry, extractProtocol } from './helpers';

import { ProtocolAdapter } from './types';

/** `[west, south, east, north]` in degrees. */
type LngLatBounds = [number, number, number, number];

/** A tile name in the XYZ scheme, as Mapbox hands it to a custom source. */
interface TileId {
	z: number;
	x: number;
	y: number;
}

/**
 * The `CustomSourceInterface` implementation built by `createRasterSource`,
 * ready for `map.addSource(id, source)`.
 */
export interface MapboxCustomRasterSource {
	type: 'custom';
	dataType: 'raster';
	tileSize: number;
	minzoom: number;
	maxzoom: number;
	attribution?: string;
	bounds?: LngLatBounds;
	loadTile: (tile: TileId, options: { signal: AbortSignal }) => Promise<ImageBitmap | null>;
}

/** Options for `createRasterSource`; all are forwarded onto the custom source. */
export interface MapboxRasterSourceOptions {
	/** Size in pixels the tiles are rendered at; the protocol's default is 512. */
	tileSize?: number;
	minzoom?: number;
	maxzoom?: number;
	attribution?: string;
	/** Tiles outside these bounds are never requested. */
	bounds?: LngLatBounds;
}

/** Options for `addVectorSource`. */
export interface MapboxVectorSourceOptions {
	/** Deepest zoom to fetch tiles at; the view is overzoomed past it. Defaults to the TileJSON's `maxzoom`. */
	maxzoom?: number;
	/** Shallowest zoom to fetch tiles at. Defaults to the TileJSON's `minzoom`. */
	minzoom?: number;
	/** Extra options for the underlying GeoJSON source (e.g. `buffer`, `tolerance`). */
	geojson?: Record<string, unknown>;
}

/** What `addVectorSource` returns: control over the viewport-synced source. */
export interface MapboxVectorSourceHandle {
	/** Re-fetch the tiles covering the current viewport and replace the source data. */
	refresh: () => Promise<void>;
	/** Stop syncing and remove the source. Remove the layers that use it first. */
	remove: () => void;
}

/** The subset of a Mapbox `Map` this adapter consumes. */
export interface MapboxMapLike {
	getZoom(): number;
	getBounds(): {
		getWest(): number;
		getSouth(): number;
		getEast(): number;
		getNorth(): number;
	} | null;
	addSource(id: string, source: Record<string, unknown>): unknown;
	removeSource(id: string): unknown;
	getSource(id: string): { setData(data: unknown): unknown } | undefined;
	on(type: string, listener: () => void): unknown;
	off(type: string, listener: () => void): unknown;
}

/**
 * The object returned by `addMapboxProtocolSupport`.
 */
export interface MapboxProtocolAdapter extends ProtocolAdapter {
	/**
	 * Build a custom raster source backed by the registered protocol handler.
	 *
	 * The result is a `CustomSourceInterface` implementation: pass it to
	 * `map.addSource(id, source)` and reference `id` from `raster` layers.
	 *
	 * @param tileJsonUrl - The `om://` TileJSON URL.
	 * @param options     - Zoom range, tile size, attribution and bounds.
	 */
	createRasterSource: (
		tileJsonUrl: string,
		options?: MapboxRasterSourceOptions
	) => MapboxCustomRasterSource;

	/**
	 * Add a GeoJSON source that mirrors the protocol's vector tiles for the
	 * current viewport and keeps following it on `moveend`.
	 *
	 * Call it once the style is loaded (e.g. in `map.on('load')`), then add
	 * `line` / `fill` / `symbol` layers on `sourceId`, filtering on the `layer`
	 * property (`wind-arrows`, `wind-barb-pennants`, `contours`, …).
	 *
	 * @param map         - The Mapbox map.
	 * @param sourceId    - Id of the GeoJSON source to create.
	 * @param tileJsonUrl - The `om://` TileJSON URL, including the vector params (`arrows=true`, `contours=true`, …).
	 * @param options     - Zoom range and GeoJSON source options.
	 */
	addVectorSource: (
		map: MapboxMapLike,
		sourceId: string,
		tileJsonUrl: string,
		options?: MapboxVectorSourceOptions
	) => MapboxVectorSourceHandle;
}

/** The protocol renders 512 px tiles and sizes its vector lattice for them. */
const DEFAULT_TILE_SIZE = 512;
const DEFAULT_MINZOOM = 0;
const DEFAULT_MAXZOOM = 12;
/** Upper bound on tiles fetched per viewport refresh, whatever the view. */
const MAX_TILES_PER_REFRESH = 128;

const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };

/** Fractional tile column / row of a coordinate at zoom `z`. */
const lon2tile = (lon: number, z: number): number => ((lon + 180) / 360) * 2 ** z;
const lat2tile = (lat: number, z: number): number => {
	const rad = (lat * Math.PI) / 180;
	return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
};
const clamp = (value: number, min: number, max: number): number =>
	Math.min(max, Math.max(min, value));

/**
 * The tiles at zoom `z` covering `bounds`. Columns are left unwrapped so a
 * view across the antimeridian keeps its longitudes continuous; `wrappedX`
 * is the column to request.
 */
const coveringTiles = (
	bounds: LngLatBounds,
	z: number
): { x: number; y: number; wrappedX: number }[] => {
	const n = 2 ** z;
	const [west, south, east, north] = bounds;
	// The far edges are exclusive: a bound sitting exactly on a tile boundary
	// does not pull in the next tile
	const minX = Math.floor(lon2tile(west, z));
	const maxX = Math.ceil(lon2tile(east, z)) - 1;
	const minY = clamp(Math.floor(lat2tile(north, z)), 0, n - 1);
	const maxY = clamp(Math.ceil(lat2tile(south, z)) - 1, 0, n - 1);

	const tiles: { x: number; y: number; wrappedX: number }[] = [];
	for (let x = minX; x <= maxX; x++) {
		for (let y = minY; y <= maxY; y++) {
			if (tiles.length >= MAX_TILES_PER_REFRESH) return tiles;
			tiles.push({ x, y, wrappedX: ((x % n) + n) % n });
		}
	}
	return tiles;
};

/**
 * Adds custom protocol support to Mapbox GL JS.
 *
 * @returns A `MapboxProtocolAdapter` with `addProtocol`, `removeProtocol`,
 *          `createRasterSource` and `addVectorSource`.
 */
export const addMapboxProtocolSupport = (): MapboxProtocolAdapter => {
	const registry = createProtocolRegistry('mapbox-adapter');

	return {
		addProtocol: (protocol, handler, settings) => {
			registry.add(protocol, handler, settings);
		},
		removeProtocol: (protocol) => {
			registry.remove(protocol);
		},

		createRasterSource: (tileJsonUrl, options = {}) => {
			const resolve = registry.makeTileJsonResolver(tileJsonUrl);
			const baseProtocol = extractProtocol(tileJsonUrl)!;

			return {
				type: 'custom',
				dataType: 'raster',
				tileSize: DEFAULT_TILE_SIZE,
				minzoom: DEFAULT_MINZOOM,
				maxzoom: DEFAULT_MAXZOOM,
				...options,

				/**
				 * Mapbox aborts `signal` when the tile is no longer wanted and
				 * ignores whatever the promise then settles to.
				 */
				loadTile: async ({ z, x, y }, { signal }) => {
					const { tileTemplate } = await resolve();
					if (signal.aborted) return null;

					const url = buildTileUrl(tileTemplate, z, x, y);
					const { handler, settings } = registry.get(extractProtocol(url) ?? baseProtocol);

					const abortController = new AbortController();
					signal.addEventListener('abort', () => abortController.abort(), { once: true });

					const response = await handler({ url, type: 'image' }, abortController, settings);
					const data = response?.data;

					// No data here (outside the domain): Mapbox renders nothing for `null`
					if (!data) return null;

					if (data instanceof ImageBitmap) {
						return data;
					}

					throw new Error(
						`[mapbox-adapter] Unsupported raster tile data type: ${Object.prototype.toString.call(data)}`
					);
				}
			};
		},

		addVectorSource: (map, sourceId, tileJsonUrl, options = {}) => {
			const resolve = registry.makeTileJsonResolver(tileJsonUrl);
			const baseProtocol = extractProtocol(tileJsonUrl)!;

			map.addSource(sourceId, {
				type: 'geojson',
				data: EMPTY_COLLECTION,
				// The shapes are a few tile units across; Mapbox's default
				// simplification would eat their detail
				tolerance: 0,
				...options.geojson
			});

			// A refresh supersedes the previous one: its fetches are cancelled and
			// a late result is never applied.
			let current: AbortController | undefined;

			const refresh = async (): Promise<void> => {
				current?.abort();
				const abortController = new AbortController();
				current = abortController;

				const { tileTemplate, tileJson } = await resolve();
				const bounds = map.getBounds();
				if (!bounds || abortController.signal.aborted) return;

				const minzoom =
					options.minzoom ?? (tileJson['minzoom'] as number | undefined) ?? DEFAULT_MINZOOM;
				const maxzoom =
					options.maxzoom ?? (tileJson['maxzoom'] as number | undefined) ?? DEFAULT_MAXZOOM;
				// Mapbox renders 512 px tiles, so the tile zoom is the integer map zoom
				const z = clamp(Math.floor(map.getZoom()), minzoom, maxzoom);
				const tiles = coveringTiles(
					[bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
					z
				);

				const results = await Promise.all(
					tiles.map(async (tile) => {
						const url = buildTileUrl(tileTemplate, z, tile.wrappedX, tile.y);
						const { handler, settings } = registry.get(extractProtocol(url) ?? baseProtocol);
						const response = await handler({ url, type: 'arrayBuffer' }, abortController, settings);
						return { tile, data: response?.data };
					})
				);
				if (abortController.signal.aborted) return;

				const features: unknown[] = [];
				for (const { tile, data } of results) {
					if (!(data instanceof ArrayBuffer) || data.byteLength === 0) continue;
					const vectorTile = new VectorTile(new PbfReader(data));
					for (const layerName of Object.keys(vectorTile.layers)) {
						const layer = vectorTile.layers[layerName];
						for (let i = 0; i < layer.length; i++) {
							const feature = layer.feature(i).toGeoJSON(tile.x, tile.y, z);
							// The MVT layer name is what a style layer filters on
							feature.properties = { layer: layerName, ...feature.properties };
							features.push(feature);
						}
					}
				}

				map.getSource(sourceId)?.setData({ type: 'FeatureCollection', features });
			};

			const onMoveEnd = () => {
				void refresh().catch((err) => {
					if (current?.signal.aborted) return;
					console.error('[mapbox-adapter] Vector source refresh error:', err);
				});
			};
			map.on('moveend', onMoveEnd);
			onMoveEnd();

			return {
				refresh,
				remove: () => {
					current?.abort();
					map.off('moveend', onMoveEnd);
					if (map.getSource(sourceId)) map.removeSource(sourceId);
				}
			};
		}
	};
};
