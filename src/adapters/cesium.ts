/**
 * CesiumJS adapter for omProtocol.
 *
 * Cesium has no custom-protocol mechanism and no vector tile renderer. This
 * module provides `addCesiumProtocolSupport`, which creates imagery providers
 * for `viewer.imageryLayers`:
 *
 *   - `createImageryProvider(tileJsonUrl, options?)` — an `ImageryProvider`
 *     whose `requestImage` calls the registered protocol handler and hands
 *     the returned `ImageBitmap` to Cesium. No PNG encode/decode cycle.
 *
 *   - `createVectorImageryProvider(tileJsonUrl, options?)` — an
 *     `ImageryProvider` that fetches PBF bytes through the protocol handler,
 *     decodes the MVT features and draws them onto a tile-sized canvas with a
 *     configurable style function, like the Leaflet vector tile layer. The
 *     result drapes over the globe and terrain like any other imagery.
 *
 * Both are asynchronous: the TileJSON is resolved first, so the provider
 * knows the extent and attribution of the data before Cesium requests tiles.
 * `ImageryLayer.fromProviderAsync` takes the promise, so the layer can still
 * be added synchronously.
 *
 * Usage:
 *
 * ```ts
 * import * as Cesium from 'cesium';
 * import { omProtocol, addCesiumProtocolSupport } from '@openmeteo/weather-map-layer';
 *
 * // 1. Create the adapter, passing the Cesium namespace.
 * const cesiumAdapter = addCesiumProtocolSupport(Cesium);
 *
 * // 2. Register your protocol handler (same signature as MapLibre's addProtocol).
 * cesiumAdapter.addProtocol('om', omProtocol);
 *
 * // 3. Create the viewer.
 * const viewer = new Cesium.Viewer('cesiumContainer');
 *
 * // 4. Add the providers as imagery layers.
 * viewer.imageryLayers.add(
 *   Cesium.ImageryLayer.fromProviderAsync(cesiumAdapter.createImageryProvider('om://' + omUrl), {
 *     alpha: 0.75
 *   })
 * );
 * viewer.imageryLayers.add(
 *   Cesium.ImageryLayer.fromProviderAsync(
 *     cesiumAdapter.createVectorImageryProvider('om://' + omUrl + '&arrows=true')
 *   )
 * );
 * ```
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import {
	type CanvasVectorStyleFn,
	defaultVectorStyle,
	extractRenderFeatures
} from './canvas-vector';
import { buildTileUrl, createProtocolRegistry, extractProtocol } from './helpers';
import { renderInWorker } from './leaflet-worker/leaflet-pbf-worker-pool';

import type { OmProtocolSettings } from '../types';
import type { ProtocolAdapter, ProtocolHandler } from './types';

/* ── Minimal Cesium type surface used by this adapter ────────────────── */

/** `Cesium.Request`, limited to what the adapter sets before scheduling it. */
export interface CesiumRequestLike {
	url?: string;
	requestFunction?: () => Promise<unknown>;
	cancelFunction?: () => void;
}

/** The subset of the Cesium namespace this adapter consumes. */
export interface CesiumLib {
	WebMercatorTilingScheme: new () => { rectangle: unknown };
	Rectangle: {
		fromDegrees(west: number, south: number, east: number, north: number): unknown;
		intersection(rectangle: unknown, otherRectangle: unknown): unknown | undefined;
	};
	Event: new () => unknown;
	Credit: new (html: string, showOnScreen?: boolean) => unknown;
	RequestScheduler: { request(request: CesiumRequestLike): Promise<unknown> | undefined };
}

/** What `requestImage` resolves to: a tile bitmap, or a transparent pixel for an empty tile. */
export type CesiumImageryTypes = ImageBitmap | ImageData;

/**
 * The `ImageryProvider` implementation built by the adapter. Plain object
 * with the properties Cesium's `ImageryLayer` reads; no `ready` or
 * `readyPromise`, which Cesium dropped with the async provider API.
 */
export interface CesiumImageryProvider {
	tilingScheme: { rectangle: unknown };
	rectangle: unknown;
	tileWidth: number;
	tileHeight: number;
	minimumLevel: number;
	maximumLevel: number;
	tileDiscardPolicy: undefined;
	proxy: undefined;
	errorEvent: unknown;
	credit: unknown;
	hasAlphaChannel: true;
	getTileCredits: (x: number, y: number, level: number) => undefined;
	/**
	 * Called by Cesium for every tile it wants. Returns `undefined` when the
	 * request scheduler has no free slot, in which case Cesium asks again on a
	 * later frame.
	 */
	requestImage: (
		x: number,
		y: number,
		level: number,
		request?: CesiumRequestLike
	) => Promise<CesiumImageryTypes> | undefined;
}

/** Options for `createImageryProvider`. */
export interface CesiumImageryProviderOptions {
	/** Shallowest level tiles are requested at. Defaults to the TileJSON's `minzoom`. */
	minimumLevel?: number;
	/** Deepest level tiles are requested at; Cesium upsamples past it. Defaults to the TileJSON's `maxzoom`. */
	maximumLevel?: number;
	/** Attribution shown by Cesium's credit display (HTML). Defaults to the TileJSON's `attribution`. */
	credit?: string;
}

/** Options for `createVectorImageryProvider`. */
export interface CesiumVectorImageryProviderOptions extends CesiumImageryProviderOptions {
	/** Style function called for each feature; see `CanvasVectorStyleFn`. */
	style?: CanvasVectorStyleFn;
}

/**
 * The object returned by `addCesiumProtocolSupport`.
 */
export interface CesiumProtocolAdapter extends ProtocolAdapter {
	/**
	 * Create a raster imagery provider backed by the registered protocol handler.
	 *
	 * Resolves once the TileJSON is known. Wrap the promise with
	 * `Cesium.ImageryLayer.fromProviderAsync` to add it to a viewer.
	 *
	 * @param tileJsonUrl - The `om://` TileJSON URL.
	 * @param options     - Level range and attribution.
	 */
	createImageryProvider: (
		tileJsonUrl: string,
		options?: CesiumImageryProviderOptions
	) => Promise<CesiumImageryProvider>;

	/**
	 * Create an imagery provider that draws the protocol's vector tiles
	 * (arrows, barbs, contours, grid points) onto raster tiles.
	 *
	 * @param tileJsonUrl - The `om://` TileJSON URL, including the vector params (`arrows=true`, `contours=true`, …).
	 * @param options     - Style function, level range and attribution.
	 */
	createVectorImageryProvider: (
		tileJsonUrl: string,
		options?: CesiumVectorImageryProviderOptions
	) => Promise<CesiumImageryProvider>;
}

/** The protocol renders 512 px tiles and sizes its vector lattice for them. */
const TILE_SIZE = 512;
const DEFAULT_MINIMUM_LEVEL = 0;
const DEFAULT_MAXIMUM_LEVEL = 12;
/** Fetches one tile through the protocol handler and turns it into what Cesium takes. */
type TileLoader = (
	url: string,
	handler: ProtocolHandler,
	settings: OmProtocolSettings | undefined,
	abortController: AbortController
) => Promise<CesiumImageryTypes>;

/**
 * Hand a bitmap rendered by the protocol to Cesium.
 *
 * Cesium uploads tiles with `UNPACK_FLIP_Y_WEBGL`, which browsers ignore for
 * `ImageBitmap` sources, so its own loader flips bitmaps while decoding them
 * and expects every provider to deliver them flipped. The protocol's bitmaps
 * are also premultiplied canvas output, while Cesium's globe shader blends
 * them as straight alpha, so they are un-premultiplied here too; otherwise
 * semi-transparent colours come out darker than on the other map libraries.
 */
const toCesiumBitmap = async (bitmap: ImageBitmap): Promise<ImageBitmap> => {
	const flipped = await createImageBitmap(bitmap, {
		imageOrientation: 'flipY',
		premultiplyAlpha: 'none'
	});
	bitmap.close();
	return flipped;
};

/** A tile with nothing to draw. Cesium treats `undefined` as a failed load, so it gets a transparent pixel. */
const emptyTile = (): ImageData => new ImageData(1, 1);

/**
 * Adds custom protocol support to CesiumJS.
 *
 * @param Cesium - The Cesium namespace (`import * as Cesium from 'cesium'` or
 *                 `window.Cesium`).
 * @returns A `CesiumProtocolAdapter` with `addProtocol`, `removeProtocol`,
 *          `createImageryProvider` and `createVectorImageryProvider`.
 */
export const addCesiumProtocolSupport = (Cesium: CesiumLib): CesiumProtocolAdapter => {
	if (!Cesium?.WebMercatorTilingScheme || !Cesium?.RequestScheduler) {
		throw new Error(
			'[cesium-adapter] Cesium.WebMercatorTilingScheme and Cesium.RequestScheduler must be available. ' +
				'Make sure Cesium is fully loaded before calling addCesiumProtocolSupport().'
		);
	}

	const registry = createProtocolRegistry('cesium-adapter');

	const createProvider = async (
		tileJsonUrl: string,
		options: CesiumImageryProviderOptions,
		loadTile: TileLoader
	): Promise<CesiumImageryProvider> => {
		const resolve = registry.makeTileJsonResolver(tileJsonUrl);
		const baseProtocol = extractProtocol(tileJsonUrl)!;
		const { tileTemplate, tileJson } = await resolve();

		const tilingScheme = new Cesium.WebMercatorTilingScheme();

		// Cesium only requests tiles inside the rectangle, so a regional domain
		// never renders (empty) tiles for the rest of the globe. Cesium assumes
		// the rectangle lies within the tiling scheme's, which a global grid's
		// bounds (latitude up to 90) exceed, hence the intersection; the scheme's
		// own rectangle rather than a latitude clamp, since converting the
		// Mercator limit from degrees can land a rounding error outside it.
		let rectangle = tilingScheme.rectangle;
		const bounds = tileJson['bounds'] as number[] | undefined;
		if (bounds?.length === 4) {
			rectangle =
				Cesium.Rectangle.intersection(
					Cesium.Rectangle.fromDegrees(bounds[0], bounds[1], bounds[2], bounds[3]),
					tilingScheme.rectangle
				) ?? tilingScheme.rectangle;
		}

		const attribution = options.credit ?? (tileJson['attribution'] as string | undefined);

		return {
			tilingScheme,
			rectangle,
			tileWidth: TILE_SIZE,
			tileHeight: TILE_SIZE,
			minimumLevel:
				options.minimumLevel ??
				(tileJson['minzoom'] as number | undefined) ??
				DEFAULT_MINIMUM_LEVEL,
			maximumLevel:
				options.maximumLevel ??
				(tileJson['maxzoom'] as number | undefined) ??
				DEFAULT_MAXIMUM_LEVEL,
			tileDiscardPolicy: undefined,
			proxy: undefined,
			errorEvent: new Cesium.Event(),
			credit: attribution ? new Cesium.Credit(attribution) : undefined,
			hasAlphaChannel: true,
			getTileCredits: () => undefined,

			requestImage: (x, y, level, request) => {
				const url = buildTileUrl(tileTemplate, level, x, y);
				const { handler, settings } = registry.get(extractProtocol(url) ?? baseProtocol);
				const abortController = new AbortController();
				const load = () => loadTile(url, handler, settings, abortController);

				if (!request) {
					return load();
				}

				// Cesium hands every tile a `Request` meant for its scheduler. Going
				// through it rather than calling the handler directly keeps Cesium's
				// cap on concurrent loads per server, and a tile that leaves the view
				// while it is postponed is never rendered at all. Cesium never cancels
				// an issued imagery request, but the hook costs nothing.
				request.url = url;
				request.requestFunction = load;
				request.cancelFunction = () => abortController.abort();
				return Cesium.RequestScheduler.request(request) as Promise<CesiumImageryTypes> | undefined;
			}
		};
	};

	const loadRasterTile: TileLoader = async (url, handler, settings, abortController) => {
		const response = await handler({ url, type: 'image' }, abortController, settings);
		const data = response?.data;

		if (!data || (data instanceof ArrayBuffer && data.byteLength === 0)) {
			return emptyTile();
		}
		if (data instanceof ImageBitmap) {
			return toCesiumBitmap(data);
		}
		throw new Error(
			`[cesium-adapter] Unsupported raster tile data type: ${Object.prototype.toString.call(data)}`
		);
	};

	const makeVectorTileLoader =
		(styleFn: CanvasVectorStyleFn): TileLoader =>
		async (url, handler, settings, abortController) => {
			const response = await handler({ url, type: 'arrayBuffer' }, abortController, settings);
			const data = response?.data;

			if (!(data instanceof ArrayBuffer) || data.byteLength === 0) {
				return emptyTile();
			}

			const vectorTile = new VectorTile(new PbfReader(data));
			const extracted = extractRenderFeatures(vectorTile, TILE_SIZE, styleFn);
			const bitmap = await renderInWorker(TILE_SIZE, extracted);
			return bitmap ? toCesiumBitmap(bitmap) : emptyTile();
		};

	return {
		addProtocol: (protocol, handler, settings) => {
			registry.add(protocol, handler, settings);
		},
		removeProtocol: (protocol) => {
			registry.remove(protocol);
		},

		createImageryProvider: (tileJsonUrl, options = {}) =>
			createProvider(tileJsonUrl, options, loadRasterTile),

		createVectorImageryProvider: (tileJsonUrl, options = {}) => {
			const { style, ...providerOptions } = options;
			return createProvider(
				tileJsonUrl,
				providerOptions,
				makeVectorTileLoader(style ?? defaultVectorStyle)
			);
		}
	};
};
