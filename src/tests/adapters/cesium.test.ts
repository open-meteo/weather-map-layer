/**
 * Unit tests for the CesiumJS adapter (addCesiumProtocolSupport).
 *
 * The adapter builds `ImageryProvider` objects for raster and rasterised
 * vector tiles; both are exercised against a mock protocol handler and a
 * minimal mock of the Cesium namespace.
 */
import { addCesiumProtocolSupport, cameraTileZoom } from '../../adapters/cesium';
import type {
	CesiumLib,
	CesiumPolylineGeometryOptions,
	CesiumPrimitive,
	CesiumRequestLike,
	CesiumViewerLike
} from '../../adapters/cesium';
import { renderInWorker } from '../../adapters/leaflet-worker/leaflet-pbf-worker-pool';
import { command, writeLayer, zigzag } from '../../utils/pbf';
import { PbfWriter } from 'pbf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../adapters/leaflet-worker/leaflet-pbf-worker-pool', () => ({
	renderInWorker: vi.fn()
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TILEJSON = {
	tiles: ['om://example.com/{z}/{x}/{y}'],
	attribution: '© Open-Meteo',
	minzoom: 0,
	maxzoom: 12,
	bounds: [-10, -95, 190, 95]
};

/** A protocol handler answering TileJSON, then the given tile data for every tile. */
const createMockHandler = (tileData: () => unknown = () => null) =>
	vi.fn(async (params: { url: string; type: string }) =>
		params.type === 'json' ? { data: TILEJSON } : { data: tileData() }
	);

/** One MVT tile with `lines` 2-point lines in layer `wind-arrows`, the first a quarter into the tile. */
const makeVectorTile = (lines = 1): ArrayBuffer => {
	const pbf = new PbfWriter();
	pbf.writeMessage(3, writeLayer, {
		name: 'wind-arrows',
		extent: 4096,
		features: Array.from({ length: lines }, (_, i) => ({
			id: i + 1,
			type: 2, // LineString
			properties: { value: 3.5 },
			geom: [
				command(1, 1),
				zigzag(1024 + i * 1024),
				zigzag(1024),
				command(2, 1),
				zigzag(512),
				zigzag(0)
			]
		}))
	});
	const bytes = pbf.finish();
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

class MockImageBitmap {
	close = vi.fn();
}

class MockImageData {
	constructor(
		public width: number,
		public height: number
	) {}
}

interface Rect {
	west: number;
	south: number;
	east: number;
	north: number;
}

/** The Web Mercator tiling scheme's rectangle, in the degrees the mock works in. */
const WORLD: Rect = { west: -180, south: -85.05112878, east: 180, north: 85.05112878 };

/** The Cesium surface the adapter touches, with a scheduler that issues requests at once. */
const createMockCesium = (): CesiumLib & {
	scheduled: CesiumRequestLike[];
} => {
	const scheduled: CesiumRequestLike[] = [];
	return {
		scheduled,
		WebMercatorTilingScheme: class {
			rectangle = WORLD;
		},
		Rectangle: {
			fromDegrees: (west: number, south: number, east: number, north: number) => ({
				west,
				south,
				east,
				north
			}),
			intersection: (a: Rect, b: Rect) => {
				const west = Math.max(a.west, b.west);
				const south = Math.max(a.south, b.south);
				const east = Math.min(a.east, b.east);
				const north = Math.min(a.north, b.north);
				return west < east && south < north ? { west, south, east, north } : undefined;
			}
		},
		Event: class {},
		Credit: class {
			constructor(public html: string) {}
		},
		RequestScheduler: {
			request: (request) => {
				scheduled.push(request);
				return request.requestFunction!();
			}
		}
	};
};

/** A primitive that records its geometry instances and is ready at once. */
class MockPrimitive implements CesiumPrimitive {
	ready = true;
	constructor(public options: { geometryInstances: unknown[]; appearance: unknown }) {}
	/** The polyline geometry options of every instance. */
	get geometries(): CesiumPolylineGeometryOptions[] {
		return this.options.geometryInstances.map(
			(instance) =>
				(instance as { geometry: { options: CesiumPolylineGeometryOptions } }).geometry.options
		);
	}
}

/** The vector layer's part of the Cesium namespace. */
const withVectorSupport = (cesium: CesiumLib): CesiumLib => ({
	...cesium,
	ArcType: { NONE: 'none' },
	Cartesian3: { fromDegreesArray: (coordinates: number[]) => coordinates },
	Color: {
		fromCssColorString: (color: string) => ({
			alpha: color === 'rgba(0, 0, 0, 0)' ? 0 : 1,
			color,
			withAlpha(alpha: number) {
				return { ...this, alpha };
			}
		})
	},
	GeometryInstance: class {
		constructor(public options: { geometry: unknown }) {}
		get geometry() {
			return this.options.geometry;
		}
	},
	PolylineColorAppearance: Object.assign(class {}, { VERTEX_FORMAT: 'vertex-format' }),
	PolylineGeometry: class {
		constructor(public options: CesiumPolylineGeometryOptions) {}
	},
	Primitive: MockPrimitive
});

/** The height at which `cameraTileZoom` sees the whole world in a 512 px viewport at the equator. */
const WORLD_HEIGHT = (Math.PI * 6378137) / Math.tan(Math.PI / 6);

interface MockViewer extends CesiumViewerLike {
	primitives: unknown[];
	listeners: Set<() => void>;
	/** Fire the scene's postRender event, where the layer swaps in a ready primitive. */
	postRender: () => void;
}

/** A viewer whose camera sees the whole world from a height that maps to tile zoom 1. */
const createMockViewer = (height = WORLD_HEIGHT / 2): MockViewer => {
	const primitives: unknown[] = [];
	const listeners = new Set<() => void>();
	const postRenderListeners = new Set<() => void>();
	return {
		primitives,
		listeners,
		postRender: () => postRenderListeners.forEach((listener) => listener()),
		scene: {
			canvas: { clientHeight: 512 },
			globe: { ellipsoid: 'wgs84' },
			primitives: {
				add: (primitive) => primitives.push(primitive),
				remove: (primitive) => {
					const index = primitives.indexOf(primitive);
					if (index === -1) return false;
					primitives.splice(index, 1);
					return true;
				}
			},
			postRender: {
				addEventListener: (listener) => postRenderListeners.add(listener),
				removeEventListener: (listener) => postRenderListeners.delete(listener)
			}
		},
		camera: {
			moveEnd: {
				addEventListener: (listener) => listeners.add(listener),
				removeEventListener: (listener) => listeners.delete(listener)
			},
			computeViewRectangle: () => ({
				west: -Math.PI,
				south: (-85 * Math.PI) / 180,
				east: Math.PI,
				north: (85 * Math.PI) / 180
			}),
			positionCartographic: { latitude: 0, height },
			frustum: { fovy: Math.PI / 3 }
		}
	};
};

/** `new Request()` as Cesium's ImageryLayer hands it to `requestImage`. */
const createRequest = (): CesiumRequestLike => ({});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('addCesiumProtocolSupport', () => {
	beforeEach(() => {
		// Stub the browser globals unavailable in Node.
		vi.stubGlobal('ImageBitmap', MockImageBitmap);
		vi.stubGlobal('ImageData', MockImageData);
		vi.stubGlobal(
			'createImageBitmap',
			vi.fn(async () => new MockImageBitmap())
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('returns an adapter with the expected interface', () => {
		const adapter = addCesiumProtocolSupport(createMockCesium());
		expect(typeof adapter.addProtocol).toBe('function');
		expect(typeof adapter.removeProtocol).toBe('function');
		expect(typeof adapter.createImageryProvider).toBe('function');
		expect(typeof adapter.createVectorImageryProvider).toBe('function');
		expect(typeof adapter.addVectorLayer).toBe('function');
	});

	it('throws when the Cesium namespace is incomplete', () => {
		expect(() => addCesiumProtocolSupport({} as CesiumLib)).toThrow(
			'Cesium.WebMercatorTilingScheme and Cesium.RequestScheduler must be available'
		);
	});

	describe('addProtocol / removeProtocol', () => {
		it('registers and unregisters a protocol without error', () => {
			const adapter = addCesiumProtocolSupport(createMockCesium());
			expect(() => adapter.addProtocol('om', createMockHandler())).not.toThrow();
			expect(() => adapter.removeProtocol('om')).not.toThrow();
		});

		it('removing a non-existent protocol does not throw', () => {
			const adapter = addCesiumProtocolSupport(createMockCesium());
			expect(() => adapter.removeProtocol('nonexistent')).not.toThrow();
		});
	});

	// ── createImageryProvider ─────────────────────────────────────────────

	describe('createImageryProvider', () => {
		it('resolves the TileJSON into the provider properties Cesium reads', async () => {
			const handler = createMockHandler();
			const adapter = addCesiumProtocolSupport(createMockCesium());
			adapter.addProtocol('om', handler);

			const provider = await adapter.createImageryProvider('om://example.com/tiles.json');

			expect(handler).toHaveBeenCalledWith(
				{ url: 'om://example.com/tiles.json', type: 'json' },
				expect.any(AbortController),
				undefined
			);
			expect(provider.tileWidth).toBe(512);
			expect(provider.tileHeight).toBe(512);
			expect(provider.minimumLevel).toBe(0);
			expect(provider.maximumLevel).toBe(12);
			expect(provider.hasAlphaChannel).toBe(true);
			expect(provider.tileDiscardPolicy).toBeUndefined();
			expect(provider.errorEvent).toBeDefined();
			expect((provider.credit as { html: string }).html).toBe('© Open-Meteo');
			expect(provider.getTileCredits(0, 0, 0)).toBeUndefined();
			expect(typeof provider.requestImage).toBe('function');
		});

		it('limits the rectangle to the TileJSON bounds within the tiling scheme', async () => {
			const adapter = addCesiumProtocolSupport(createMockCesium());
			adapter.addProtocol('om', createMockHandler());

			const provider = await adapter.createImageryProvider('om://example.com/tiles.json');

			expect(provider.rectangle).toEqual({
				west: -10,
				south: -85.05112878,
				east: 180,
				north: 85.05112878
			});
		});

		it('forwards options over the TileJSON values', async () => {
			const adapter = addCesiumProtocolSupport(createMockCesium());
			adapter.addProtocol('om', createMockHandler());

			const provider = await adapter.createImageryProvider('om://example.com/tiles.json', {
				minimumLevel: 2,
				maximumLevel: 8,
				credit: '© Test'
			});

			expect(provider.minimumLevel).toBe(2);
			expect(provider.maximumLevel).toBe(8);
			expect((provider.credit as { html: string }).html).toBe('© Test');
		});

		it('requestImage schedules the tile with Cesium and resolves to the flipped bitmap', async () => {
			const bitmap = new MockImageBitmap();
			const flipped = new MockImageBitmap();
			vi.mocked(createImageBitmap).mockResolvedValue(flipped as unknown as ImageBitmap);
			const handler = createMockHandler(() => bitmap);
			const cesium = createMockCesium();
			const adapter = addCesiumProtocolSupport(cesium);
			adapter.addProtocol('om', handler);

			const provider = await adapter.createImageryProvider('om://example.com/tiles.json');
			const request = createRequest();
			const result = await provider.requestImage(10, 15, 5, request);

			expect(cesium.scheduled).toEqual([request]);
			expect(request.url).toBe('om://example.com/5/10/15');
			expect(handler).toHaveBeenLastCalledWith(
				{ url: 'om://example.com/5/10/15', type: 'image' },
				expect.any(AbortController),
				undefined
			);
			// Cesium expects bitmaps flipped at decode and blends them as straight alpha
			expect(createImageBitmap).toHaveBeenCalledWith(bitmap, {
				imageOrientation: 'flipY',
				premultiplyAlpha: 'none'
			});
			expect(bitmap.close).toHaveBeenCalled();
			expect(result).toBe(flipped);
		});

		it('requestImage resolves to a transparent pixel when the protocol has no data for the tile', async () => {
			const adapter = addCesiumProtocolSupport(createMockCesium());
			adapter.addProtocol(
				'om',
				createMockHandler(() => new ArrayBuffer(0))
			);

			const provider = await adapter.createImageryProvider('om://example.com/tiles.json');
			const result = await provider.requestImage(10, 15, 5, createRequest());

			expect(result).toBeInstanceOf(MockImageData);
			expect((result as unknown as MockImageData).width).toBe(1);
		});

		it('requestImage returns undefined while the scheduler postpones the tile', async () => {
			const handler = createMockHandler(() => new MockImageBitmap());
			const cesium = createMockCesium();
			cesium.RequestScheduler.request = () => undefined;
			const adapter = addCesiumProtocolSupport(cesium);
			adapter.addProtocol('om', handler);

			const provider = await adapter.createImageryProvider('om://example.com/tiles.json');
			const result = provider.requestImage(10, 15, 5, createRequest());

			expect(result).toBeUndefined();
			// Nothing was rendered for the postponed tile
			expect(handler.mock.calls.filter(([params]) => params.type === 'image')).toHaveLength(0);
		});

		it("requestImage forwards Cesium's cancel to the handler's controller", async () => {
			let handlerController: AbortController | undefined;
			const handler = vi.fn(async (params: { type: string }, controller: AbortController) => {
				if (params.type === 'json') return { data: TILEJSON };
				handlerController = controller;
				return { data: new MockImageBitmap() };
			});
			const adapter = addCesiumProtocolSupport(createMockCesium());
			adapter.addProtocol('om', handler);

			const provider = await adapter.createImageryProvider('om://example.com/tiles.json');
			const request = createRequest();
			await provider.requestImage(10, 15, 5, request);

			expect(handlerController?.signal.aborted).toBe(false);
			request.cancelFunction!();
			expect(handlerController?.signal.aborted).toBe(true);
		});

		it('requestImage loads directly when called without a request', async () => {
			const cesium = createMockCesium();
			const adapter = addCesiumProtocolSupport(cesium);
			adapter.addProtocol(
				'om',
				createMockHandler(() => new MockImageBitmap())
			);

			const provider = await adapter.createImageryProvider('om://example.com/tiles.json');
			const result = await provider.requestImage(10, 15, 5);

			expect(cesium.scheduled).toEqual([]);
			expect(result).toBeInstanceOf(MockImageBitmap);
		});

		it('requestImage rejects unsupported tile data', async () => {
			const adapter = addCesiumProtocolSupport(createMockCesium());
			adapter.addProtocol(
				'om',
				createMockHandler(() => 'not a bitmap')
			);

			const provider = await adapter.createImageryProvider('om://example.com/tiles.json');
			await expect(provider.requestImage(10, 15, 5, createRequest())).rejects.toThrow(
				'Unsupported raster tile data type'
			);
		});
	});

	// ── createVectorImageryProvider ───────────────────────────────────────

	describe('createVectorImageryProvider', () => {
		it('decodes the PBF tile, renders it on a canvas and hands the bitmap to Cesium', async () => {
			const rendered = new MockImageBitmap();
			vi.mocked(renderInWorker).mockResolvedValue(rendered as unknown as ImageBitmap);
			const handler = createMockHandler(makeVectorTile);
			const style = vi.fn(() => ({ strokeStyle: 'red', lineWidth: 3 }));
			const adapter = addCesiumProtocolSupport(createMockCesium());
			adapter.addProtocol('om', handler);

			const provider = await adapter.createVectorImageryProvider(
				'om://example.com/tiles.json?arrows=true',
				{ style }
			);
			await provider.requestImage(0, 0, 1, createRequest());

			expect(handler).toHaveBeenLastCalledWith(
				{ url: 'om://example.com/1/0/0', type: 'arrayBuffer' },
				expect.any(AbortController),
				undefined
			);
			expect(style).toHaveBeenCalledWith({ layer: 'wind-arrows', value: 3.5 }, 'wind-arrows');
			expect(renderInWorker).toHaveBeenCalledWith(512, {
				features: [
					expect.objectContaining({
						type: 2,
						// MVT extent 4096 scaled to the 512 px tile
						rings: [[128, 128, 192, 128]],
						strokeStyle: 'red',
						lineWidth: 3
					})
				]
			});
			expect(createImageBitmap).toHaveBeenCalledWith(rendered, {
				imageOrientation: 'flipY',
				premultiplyAlpha: 'none'
			});
		});

		it('resolves to a transparent pixel for an empty tile without rendering', async () => {
			vi.mocked(renderInWorker).mockClear();
			const adapter = addCesiumProtocolSupport(createMockCesium());
			adapter.addProtocol(
				'om',
				createMockHandler(() => new ArrayBuffer(0))
			);

			const provider = await adapter.createVectorImageryProvider('om://example.com/tiles.json');
			const result = await provider.requestImage(0, 0, 1, createRequest());

			expect(result).toBeInstanceOf(MockImageData);
			expect(renderInWorker).not.toHaveBeenCalled();
		});
	});

	// ── cameraTileZoom ────────────────────────────────────────────────────

	describe('cameraTileZoom', () => {
		it('matches the viewport height to the world at zoom 0 and halves the height per zoom', () => {
			expect(cameraTileZoom(WORLD_HEIGHT, 0, 512)).toBe(0);
			expect(cameraTileZoom(WORLD_HEIGHT / 2, 0, 512)).toBe(1);
			expect(cameraTileZoom(WORLD_HEIGHT / 8, 0, 512)).toBe(3);
			// A viewport twice as tall shows twice the tiles at the same resolution
			expect(cameraTileZoom(WORLD_HEIGHT, 0, 1024)).toBe(1);
		});

		it('follows the shrinking Mercator metre towards the poles', () => {
			expect(cameraTileZoom(WORLD_HEIGHT / 2, Math.PI / 3, 512)).toBe(0);
		});
	});

	// ── addVectorLayer ────────────────────────────────────────────────────

	describe('addVectorLayer', () => {
		it('throws when the Cesium namespace lacks the primitives API', () => {
			const adapter = addCesiumProtocolSupport(createMockCesium());
			expect(() =>
				adapter.addVectorLayer(createMockViewer(), 'om://example.com/tiles.json')
			).toThrow('Primitive must be available');
		});

		it('follows moveEnd and fetches the tiles covering the view at the camera zoom', async () => {
			const handler = createMockHandler(makeVectorTile);
			const adapter = addCesiumProtocolSupport(withVectorSupport(createMockCesium()));
			adapter.addProtocol('om', handler);
			const viewer = createMockViewer();

			const handle = adapter.addVectorLayer(viewer, 'om://example.com/tiles.json?arrows=true');
			expect(viewer.listeners.size).toBe(1);
			await handle.refresh();

			// The world at zoom 1 is 2×2 tiles, requested through the TileJSON's template
			const tileCalls = handler.mock.calls.filter(([params]) => params.type === 'arrayBuffer');
			expect(tileCalls.map(([params]) => params.url).sort()).toEqual([
				'om://example.com/1/0/0',
				'om://example.com/1/0/1',
				'om://example.com/1/1/0',
				'om://example.com/1/1/1'
			]);
		});

		it('chains the lines of a tile into one geometry per width with the resolved style', async () => {
			const adapter = addCesiumProtocolSupport(withVectorSupport(createMockCesium()));
			adapter.addProtocol('om', createMockHandler(makeVectorTile));
			const viewer = createMockViewer();
			const style = vi.fn(() => ({ strokeStyle: 'rgba(255, 0, 0, 1)', lineWidth: 3 }));

			const handle = adapter.addVectorLayer(viewer, 'om://example.com/tiles.json', { style });
			await handle.refresh();

			expect(style).toHaveBeenCalledWith({ layer: 'wind-arrows', value: 3.5 }, 'wind-arrows');
			// One primitive per tile, each with one line of one width
			expect(viewer.primitives).toHaveLength(4);
			const primitive = viewer.primitives[0] as MockPrimitive;
			expect(primitive.geometries).toHaveLength(1);
			const geometry = primitive.geometries[0];
			expect(geometry.width).toBe(3);
			expect(geometry.colorsPerVertex).toBe(false);
			expect(geometry.arcType).toBe('none');
			// One segment, so one colour
			expect(geometry.colors).toHaveLength(1);
			expect(geometry.colors[0]).toMatchObject({ color: 'rgba(255, 0, 0, 1)' });
			// Tile 1/0/0 spans lon -180..0; the line starts a quarter into it
			const positions = geometry.positions as number[];
			expect(positions).toHaveLength(4);
			expect(positions[0]).toBeCloseTo(-135, 5);
			expect(positions[1]).toBeGreaterThan(0);
		});

		it('joins the parts of a tile with transparent connector segments', async () => {
			const adapter = addCesiumProtocolSupport(withVectorSupport(createMockCesium()));
			adapter.addProtocol(
				'om',
				createMockHandler(() => makeVectorTile(2))
			);
			const viewer = createMockViewer();
			const style = () => ({ lineWidth: 2 });

			const handle = adapter.addVectorLayer(viewer, 'om://example.com/tiles.json', { style });
			await handle.refresh();

			// Two lines of one width: one geometry of four points, whose middle
			// segment is the invisible connector
			const [geometry] = (viewer.primitives[0] as MockPrimitive).geometries;
			expect((geometry.positions as number[]).length / 2).toBe(4);
			expect(geometry.colors.map((color) => color.alpha)).toEqual([1, 0, 1]);
		});

		it('keeps the tiles still in view and drops the rest once the new ones are ready', async () => {
			const handler = createMockHandler(makeVectorTile);
			const adapter = addCesiumProtocolSupport(withVectorSupport(createMockCesium()));
			adapter.addProtocol('om', handler);
			const viewer = createMockViewer();
			const tileCalls = () =>
				handler.mock.calls.filter(([params]) => params.type === 'arrayBuffer');

			const handle = adapter.addVectorLayer(viewer, 'om://example.com/tiles.json');
			await handle.refresh();
			viewer.postRender();
			const atZoom1 = [...viewer.primitives];
			expect(atZoom1).toHaveLength(4);

			// The same view again: nothing fetched, nothing rebuilt
			await handle.refresh();
			expect(tileCalls()).toHaveLength(4);
			expect(viewer.primitives).toEqual(atZoom1);

			// Zoom in: the 16 tiles of zoom 2 join the 4 of zoom 1 until they can render
			viewer.camera.positionCartographic.height = WORLD_HEIGHT / 4;
			await handle.refresh();
			expect(viewer.primitives).toHaveLength(20);
			viewer.postRender();
			expect(viewer.primitives).toHaveLength(16);
			expect(viewer.primitives.some((primitive) => atZoom1.includes(primitive))).toBe(false);

			handle.remove();
			expect(viewer.primitives).toHaveLength(0);
			expect(viewer.listeners.size).toBe(0);
		});

		it('waits for the new tiles before dropping stale ones', async () => {
			const adapter = addCesiumProtocolSupport(withVectorSupport(createMockCesium()));
			adapter.addProtocol('om', createMockHandler(makeVectorTile));
			const viewer = createMockViewer();

			const handle = adapter.addVectorLayer(viewer, 'om://example.com/tiles.json');
			await handle.refresh();
			viewer.postRender();

			viewer.camera.positionCartographic.height = WORLD_HEIGHT / 4;
			await handle.refresh();
			// Cesium's workers are still combining one of the new tiles
			(viewer.primitives[19] as MockPrimitive).ready = false;
			viewer.postRender();
			expect(viewer.primitives).toHaveLength(20);
			(viewer.primitives[19] as MockPrimitive).ready = true;
			viewer.postRender();
			expect(viewer.primitives).toHaveLength(16);
		});

		it('reuses a decoded tile that comes back into view', async () => {
			const handler = createMockHandler(makeVectorTile);
			const adapter = addCesiumProtocolSupport(withVectorSupport(createMockCesium()));
			adapter.addProtocol('om', handler);
			const viewer = createMockViewer();
			const tileCalls = () =>
				handler.mock.calls.filter(([params]) => params.type === 'arrayBuffer');

			const handle = adapter.addVectorLayer(viewer, 'om://example.com/tiles.json');
			await handle.refresh();
			viewer.postRender();
			viewer.camera.positionCartographic.height = WORLD_HEIGHT / 4;
			await handle.refresh();
			viewer.postRender();
			expect(tileCalls()).toHaveLength(20);

			viewer.camera.positionCartographic.height = WORLD_HEIGHT / 2;
			await handle.refresh();
			viewer.postRender();
			expect(tileCalls()).toHaveLength(20);
			expect(viewer.primitives).toHaveLength(4);
		});

		it('clamps the tile zoom to the zoom range and skips empty tiles', async () => {
			const handler = createMockHandler(() => new ArrayBuffer(0));
			const adapter = addCesiumProtocolSupport(withVectorSupport(createMockCesium()));
			adapter.addProtocol('om', handler);
			const viewer = createMockViewer(WORLD_HEIGHT / 64);

			const handle = adapter.addVectorLayer(viewer, 'om://example.com/tiles.json', { maxzoom: 2 });
			await handle.refresh();

			const tileCalls = handler.mock.calls.filter(([params]) => params.type === 'arrayBuffer');
			expect(tileCalls).toHaveLength(16);
			expect(tileCalls.every(([params]) => params.url.includes('/2/'))).toBe(true);
			// Nothing to draw: no primitive at all
			expect(viewer.primitives).toEqual([]);
		});
	});
});
