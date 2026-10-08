/**
 * Unit tests for the CesiumJS adapter (addCesiumProtocolSupport).
 *
 * The adapter builds `ImageryProvider` objects for raster and rasterised
 * vector tiles; both are exercised against a mock protocol handler and a
 * minimal mock of the Cesium namespace.
 */
import { addCesiumProtocolSupport } from '../../adapters/cesium';
import type { CesiumLib, CesiumRequestLike } from '../../adapters/cesium';
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

/** One MVT tile with a single 2-point line in layer `wind-arrows`. */
const makeVectorTile = (): ArrayBuffer => {
	const pbf = new PbfWriter();
	pbf.writeMessage(3, writeLayer, {
		name: 'wind-arrows',
		extent: 4096,
		features: [
			{
				id: 1,
				type: 2, // LineString
				properties: { value: 3.5 },
				geom: [command(1, 1), zigzag(1024), zigzag(1024), command(2, 1), zigzag(512), zigzag(0)]
			}
		]
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
});
