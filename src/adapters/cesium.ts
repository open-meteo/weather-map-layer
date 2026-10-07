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
 *   - `addVectorLayer(viewer, tileJsonUrl, options?)` — draws the protocol's
 *     vector tiles (arrows, barbs, contours) as polylines in world space, one
 *     `Primitive` per tile. The tiles covering the view are fetched at one
 *     zoom level derived from the camera height and followed on every
 *     `moveEnd`, so the shapes keep their line width on screen and their
 *     density over the globe, where draped imagery would mix tile levels
 *     across the view.
 *
 *   - `createVectorImageryProvider(tileJsonUrl, options?)` — an
 *     `ImageryProvider` that fetches PBF bytes through the protocol handler,
 *     decodes the MVT features and draws them onto a tile-sized canvas with a
 *     configurable style function, like the Leaflet vector tile layer. The
 *     result drapes over the globe and terrain like any other imagery; use it
 *     where the shapes must follow terrain.
 *
 * The providers are asynchronous: the TileJSON is resolved first, so the
 * provider knows the extent and attribution of the data before Cesium
 * requests tiles. `ImageryLayer.fromProviderAsync` takes the promise, so the
 * layer can still be added synchronously.
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
 * cesiumAdapter.addVectorLayer(viewer, 'om://' + omUrl + '&arrows=true');
 * ```
 */
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import {
	type CanvasVectorStyleFn,
	defaultVectorStyle,
	extractRenderFeatures
} from './canvas-vector';
import {
	type LngLatBounds,
	buildTileUrl,
	clamp,
	coveringTiles,
	createProtocolRegistry,
	extractProtocol
} from './helpers';
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

/** `Cesium.Color`, limited to what the vector layer uses. */
interface CesiumColor {
	alpha: number;
	withAlpha(alpha: number): CesiumColor;
}

/** `Cesium.Primitive`, limited to what the vector layer uses. */
export interface CesiumPrimitive {
	/** True once the geometry has been combined (in Cesium's workers) and the primitive renders. */
	ready: boolean;
}

/** Options of `Cesium.PolylineGeometry` the vector layer sets. */
export interface CesiumPolylineGeometryOptions {
	positions: unknown[];
	width: number;
	colors: CesiumColor[];
	colorsPerVertex: false;
	arcType: unknown;
	vertexFormat: unknown;
}

/** A Cesium event, limited to listener registration. */
interface CesiumEvent {
	addEventListener(listener: () => void): unknown;
	removeEventListener(listener: () => void): unknown;
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
	// The vector layer only
	ArcType?: { NONE: unknown };
	Cartesian3?: { fromDegreesArray(coordinates: number[]): unknown[] };
	Color?: { fromCssColorString(color: string): CesiumColor };
	GeometryInstance?: new (options: { geometry: unknown }) => unknown;
	PolylineColorAppearance?: (new () => unknown) & { VERTEX_FORMAT: unknown };
	PolylineGeometry?: new (options: CesiumPolylineGeometryOptions) => unknown;
	Primitive?: new (options: {
		geometryInstances: unknown[];
		appearance: unknown;
		asynchronous: boolean;
	}) => CesiumPrimitive;
}

/** A rectangle in radians, as the camera reports its view. */
interface CesiumRectangle {
	west: number;
	south: number;
	east: number;
	north: number;
}

/** The subset of a Cesium `Viewer` the vector layer consumes. */
export interface CesiumViewerLike {
	scene: {
		canvas: { clientHeight: number };
		globe: { ellipsoid: unknown };
		primitives: { add(primitive: unknown): unknown; remove(primitive: unknown): boolean };
		postRender: CesiumEvent;
	};
	camera: {
		moveEnd: CesiumEvent;
		computeViewRectangle(ellipsoid?: unknown): CesiumRectangle | undefined;
		positionCartographic: { latitude: number; height: number };
		frustum: { fovy?: number };
	};
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

/** Options for `addVectorLayer`. */
export interface CesiumVectorLayerOptions {
	/** Style function called for each feature; `lineCap` is ignored, Cesium polylines have none. */
	style?: CanvasVectorStyleFn;
	/** Deepest zoom to fetch tiles at. Defaults to the TileJSON's `maxzoom`. */
	maxzoom?: number;
	/** Shallowest zoom to fetch tiles at. Defaults to the TileJSON's `minzoom`. */
	minzoom?: number;
}

/** What `addVectorLayer` returns: control over the view-synced layer. */
export interface CesiumVectorLayerHandle {
	/**
	 * Fetch the tiles covering the current view that are not drawn yet and
	 * build their polylines. Resolves once their primitives are in the scene;
	 * tiles no longer covering the view go on the first frame all new ones can
	 * render.
	 */
	refresh: () => Promise<void>;
	/** Stop following the camera and remove the polylines from the scene. */
	remove: () => void;
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

	/**
	 * Draw the protocol's vector tiles as polylines in world space and keep
	 * them following the camera.
	 *
	 * @param viewer      - The Cesium viewer (or any object with its `scene` and `camera`).
	 * @param tileJsonUrl - The `om://` TileJSON URL, including the vector params (`arrows=true`, `contours=true`, …).
	 * @param options     - Style function and zoom range.
	 */
	addVectorLayer: (
		viewer: CesiumViewerLike,
		tileJsonUrl: string,
		options?: CesiumVectorLayerOptions
	) => CesiumVectorLayerHandle;
}

/** The protocol renders 512 px tiles and sizes its vector lattice for them. */
const TILE_SIZE = 512;
const DEFAULT_MINIMUM_LEVEL = 0;
const DEFAULT_MAXIMUM_LEVEL = 12;
const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;
/** Cesium's default vertical field of view. */
const DEFAULT_FOVY = Math.PI / 3;
/** The view when the camera sees no part of the globe, in degrees. */
const WORLD_BOUNDS: LngLatBounds = [-180, -85.05112878, 180, 85.05112878];
/** Decoded vector tiles kept after their primitive is gone, so a tile coming back into view is not fetched again. */
const DECODED_TILE_CACHE_SIZE = 512;

/**
 * The polylines of one tile sharing a line width, chained into a single line
 * strip: every part starts with an invisible segment from the end of the
 * previous one. Per-segment colours let one geometry carry all of them, and
 * a tile then costs one or two geometries instead of thousands of polylines,
 * which is what keeps Cesium's geometry combining and the frame rate fast. A
 * primitive per tile, rather than one for the view, lets each tile show as
 * soon as its own geometry is combined and survive a pan unchanged.
 */
interface ChainedLines {
	/** Flat `[lon, lat, lon, lat, …]` in degrees. */
	positions: number[];
	/** One colour per segment, transparent for the connectors. */
	colors: CesiumColor[];
}

/** A decoded tile: its chained lines by line width. */
type DecodedTile = Map<number, ChainedLines>;

/**
 * The tile zoom whose 512 px tiles match the camera's ground resolution, as
 * MapLibre's integer zoom does for a 2D map: the ground span of the viewport
 * height (`2 h tan(fovy / 2)`, looking straight down) in Web Mercator metres
 * at the camera's latitude, over the world size at that zoom.
 */
export const cameraTileZoom = (
	height: number,
	latitude: number,
	canvasHeight: number,
	fovy = DEFAULT_FOVY
): number => {
	const groundSpan = 2 * height * Math.tan(fovy / 2);
	const worldSpan = EARTH_CIRCUMFERENCE * Math.cos(latitude);
	return Math.floor(Math.log2((worldSpan * canvasHeight) / (TILE_SIZE * groundSpan)));
};
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

	const addVectorLayer = (
		viewer: CesiumViewerLike,
		tileJsonUrl: string,
		options: CesiumVectorLayerOptions = {}
	): CesiumVectorLayerHandle => {
		const {
			ArcType,
			Cartesian3,
			Color,
			GeometryInstance,
			PolylineColorAppearance,
			PolylineGeometry,
			Primitive
		} = Cesium;
		if (
			!ArcType ||
			!Cartesian3 ||
			!Color ||
			!GeometryInstance ||
			!PolylineColorAppearance ||
			!PolylineGeometry ||
			!Primitive
		) {
			throw new Error(
				'[cesium-adapter] Cesium.ArcType, Cartesian3, Color, GeometryInstance, PolylineColorAppearance, PolylineGeometry and Primitive must be available for addVectorLayer().'
			);
		}
		const resolve = registry.makeTileJsonResolver(tileJsonUrl);
		const baseProtocol = extractProtocol(tileJsonUrl)!;
		const styleFn = options.style ?? defaultVectorStyle;

		const colors = new Map<string, CesiumColor>();
		const colorFor = (strokeStyle: string, globalAlpha: number): CesiumColor => {
			const key = `${strokeStyle}|${globalAlpha}`;
			let color = colors.get(key);
			if (!color) {
				const base = Color.fromCssColorString(strokeStyle);
				color = globalAlpha === 1 ? base : base.withAlpha(base.alpha * globalAlpha);
				colors.set(key, color);
			}
			return color;
		};
		const transparent = Color.fromCssColorString('rgba(0, 0, 0, 0)');

		const decodeTile = (data: ArrayBuffer, x: number, y: number, z: number): DecodedTile => {
			const decoded: DecodedTile = new Map();
			const vectorTile = new VectorTile(new PbfReader(data));
			for (const layerName of Object.keys(vectorTile.layers)) {
				const layer = vectorTile.layers[layerName];
				for (let i = 0; i < layer.length; i++) {
					const feature = layer.feature(i);
					const properties: Record<string, unknown> = { layer: layerName, ...feature.properties };
					const style = styleFn(properties, layerName);
					if (!style) continue;
					const value = Number(properties['value']) || 0;
					const strokeStyle =
						typeof style.strokeStyle === 'function'
							? style.strokeStyle(value)
							: (style.strokeStyle ?? 'rgba(0, 0, 0, 0.4)');
					const width =
						typeof style.lineWidth === 'function'
							? style.lineWidth(value)
							: (style.lineWidth ?? 1.5);
					const globalAlpha =
						typeof style.globalAlpha === 'function'
							? style.globalAlpha(value)
							: (style.globalAlpha ?? 1);
					const color = colorFor(strokeStyle, globalAlpha);

					// Lines as they are; polygons (barb pennants) as their outlines.
					// Points (grid points) have no polyline to draw.
					const { geometry } = feature.toGeoJSON(x, y, z);
					const lines: number[][][] =
						geometry.type === 'LineString'
							? [geometry.coordinates]
							: geometry.type === 'MultiLineString' || geometry.type === 'Polygon'
								? geometry.coordinates
								: geometry.type === 'MultiPolygon'
									? geometry.coordinates.flat()
									: [];

					let chained = decoded.get(width);
					if (!chained) {
						chained = { positions: [], colors: [] };
						decoded.set(width, chained);
					}
					for (const line of lines) {
						if (line.length < 2) continue;
						// The connector from the previous part is a segment too
						if (chained.positions.length > 0) chained.colors.push(transparent);
						chained.positions.push(line[0][0], line[0][1]);
						for (let k = 1; k < line.length; k++) {
							chained.positions.push(line[k][0], line[k][1]);
							chained.colors.push(color);
						}
					}
				}
			}
			return decoded;
		};

		const decodedTiles = new Map<string, DecodedTile>();
		const rememberTile = (key: string, tile: DecodedTile): void => {
			if (decodedTiles.size >= DECODED_TILE_CACHE_SIZE) {
				decodedTiles.delete(decodedTiles.keys().next().value!);
			}
			decodedTiles.set(key, tile);
		};

		/** The view's bounds in degrees, for the covering tiles. */
		const viewBounds = (): LngLatBounds => {
			const rectangle = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
			if (!rectangle) return WORLD_BOUNDS;
			const degrees = 180 / Math.PI;
			let east = rectangle.east * degrees;
			const west = rectangle.west * degrees;
			// Across the antimeridian the longitudes are kept continuous
			if (east < west) east += 360;
			return [west, rectangle.south * degrees, east, rectangle.north * degrees];
		};

		/** The primitive of every tile in the scene, drawn or still combining its geometry. */
		const primitives = new Map<string, CesiumPrimitive>();
		/** Tile decodes under way, so a refresh never fetches a tile twice. */
		const inflight = new Map<
			string,
			{ controller: AbortController; promise: Promise<DecodedTile> }
		>();
		/** The tiles of the latest refresh; the rest is stale. */
		let wanted = new Set<string>();

		// Stale tiles stay until every wanted tile can render, so the layer
		// never blinks, after a zoom change as much as after a pan
		const onPostRender = () => {
			if (primitives.size <= wanted.size) return;
			for (const key of wanted) {
				const primitive = primitives.get(key);
				if (primitive && !primitive.ready) return;
			}
			for (const [key, primitive] of primitives) {
				if (wanted.has(key)) continue;
				viewer.scene.primitives.remove(primitive);
				primitives.delete(key);
			}
		};
		viewer.scene.postRender.addEventListener(onPostRender);

		const buildPrimitive = (tile: DecodedTile): CesiumPrimitive | undefined => {
			const instances: unknown[] = [];
			for (const [width, chained] of tile) {
				instances.push(
					new GeometryInstance({
						geometry: new PolylineGeometry({
							positions: Cartesian3.fromDegreesArray(chained.positions),
							width,
							colors: chained.colors,
							colorsPerVertex: false,
							// Straight segments: the shapes are a few pixels long and
							// the connectors invisible, so nothing needs subdividing
							arcType: ArcType.NONE,
							vertexFormat: PolylineColorAppearance.VERTEX_FORMAT
						})
					})
				);
			}
			// An empty primitive never becomes ready
			if (instances.length === 0) return undefined;
			return new Primitive({
				geometryInstances: instances,
				appearance: new PolylineColorAppearance(),
				asynchronous: true
			});
		};

		const refresh = async (): Promise<void> => {
			const { tileTemplate, tileJson } = await resolve();

			const minzoom =
				options.minzoom ?? (tileJson['minzoom'] as number | undefined) ?? DEFAULT_MINIMUM_LEVEL;
			const maxzoom =
				options.maxzoom ?? (tileJson['maxzoom'] as number | undefined) ?? DEFAULT_MAXIMUM_LEVEL;
			const { positionCartographic, frustum } = viewer.camera;
			const z = clamp(
				cameraTileZoom(
					positionCartographic.height,
					positionCartographic.latitude,
					viewer.scene.canvas.clientHeight,
					frustum.fovy ?? DEFAULT_FOVY
				),
				minzoom,
				maxzoom
			);
			const tiles = coveringTiles(viewBounds(), z);
			// Unwrapped column: across the antimeridian the same data tile
			// decodes to different longitudes
			wanted = new Set(tiles.map((tile) => `${z}/${tile.x}/${tile.y}`));

			// Fetches of tiles that left the view are not worth finishing
			for (const [key, { controller }] of inflight) {
				if (!wanted.has(key)) {
					controller.abort();
					inflight.delete(key);
				}
			}

			await Promise.all(
				tiles.map(async (tile) => {
					const key = `${z}/${tile.x}/${tile.y}`;
					if (primitives.has(key)) return;

					let decoded = decodedTiles.get(key);
					if (!decoded) {
						let entry = inflight.get(key);
						if (!entry) {
							const controller = new AbortController();
							const url = buildTileUrl(tileTemplate, z, tile.wrappedX, tile.y);
							const { handler, settings } = registry.get(extractProtocol(url) ?? baseProtocol);
							const promise = handler({ url, type: 'arrayBuffer' }, controller, settings).then(
								(response) => {
									const data = response?.data;
									return data instanceof ArrayBuffer && data.byteLength > 0
										? decodeTile(data, tile.x, tile.y, z)
										: new Map();
								}
							);
							entry = { controller, promise };
							inflight.set(key, entry);
						}
						try {
							decoded = await entry.promise;
						} catch (err) {
							if (entry.controller.signal.aborted) return;
							throw err;
						} finally {
							if (inflight.get(key) === entry) inflight.delete(key);
						}
						if (entry.controller.signal.aborted) return;
						rememberTile(key, decoded);
					}
					// Several refreshes can await the same decode; the first one
					// to return draws it
					if (!wanted.has(key) || primitives.has(key)) return;
					const primitive = buildPrimitive(decoded);
					if (!primitive) return;
					primitives.set(key, primitive);
					viewer.scene.primitives.add(primitive);
				})
			);
		};

		const onMoveEnd = () => {
			void refresh().catch((err) => {
				console.error('[cesium-adapter] Vector layer refresh error:', err);
			});
		};
		viewer.camera.moveEnd.addEventListener(onMoveEnd);
		onMoveEnd();

		return {
			refresh,
			remove: () => {
				viewer.camera.moveEnd.removeEventListener(onMoveEnd);
				viewer.scene.postRender.removeEventListener(onPostRender);
				for (const { controller } of inflight.values()) controller.abort();
				inflight.clear();
				wanted = new Set();
				for (const primitive of primitives.values()) viewer.scene.primitives.remove(primitive);
				primitives.clear();
			}
		};
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
		},

		addVectorLayer
	};
};
