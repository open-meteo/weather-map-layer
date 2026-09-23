/**
 * Unit tests for the Mapbox GL JS adapter (addMapboxProtocolSupport).
 *
 * The adapter builds a `CustomSourceInterface` raster source and a
 * viewport-synced GeoJSON vector source; both are exercised against a mock
 * protocol handler and a minimal mock of the Mapbox `Map` surface.
 */
import { addMapboxProtocolSupport } from '../../adapters/mapbox';
import type { MapboxMapLike } from '../../adapters/mapbox';
import { command, writeLayer, zigzag } from '../../utils/pbf';
import { PbfWriter } from 'pbf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TILEJSON = {
	tiles: ['om://example.com/{z}/{x}/{y}'],
	attribution: '© Open-Meteo',
	minzoom: 0,
	maxzoom: 12,
	bounds: [-180, -90, 180, 90]
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

interface MockMap extends MapboxMapLike {
	sources: Map<string, Record<string, unknown>>;
	setData: ReturnType<typeof vi.fn>;
	listeners: Map<string, () => void>;
}

/** A Mapbox map showing the world at zoom 1. */
const createMockMap = (zoom = 1): MockMap => {
	const sources = new Map<string, Record<string, unknown>>();
	const setData = vi.fn();
	const listeners = new Map<string, () => void>();
	return {
		sources,
		setData,
		listeners,
		getZoom: () => zoom,
		getBounds: () => ({
			getWest: () => -180,
			getSouth: () => -85,
			getEast: () => 180,
			getNorth: () => 85
		}),
		addSource: (id, source) => sources.set(id, source),
		removeSource: (id) => sources.delete(id),
		getSource: (id) => (sources.has(id) ? { setData } : undefined),
		on: (type, listener) => listeners.set(type, listener),
		off: (type) => listeners.delete(type)
	};
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('addMapboxProtocolSupport', () => {
	beforeEach(() => {
		// Stub the browser global unavailable in Node.
		vi.stubGlobal('ImageBitmap', class ImageBitmap {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('returns an adapter with the expected interface', () => {
		const adapter = addMapboxProtocolSupport();
		expect(typeof adapter.addProtocol).toBe('function');
		expect(typeof adapter.removeProtocol).toBe('function');
		expect(typeof adapter.createRasterSource).toBe('function');
		expect(typeof adapter.addVectorSource).toBe('function');
	});

	describe('addProtocol / removeProtocol', () => {
		it('registers and unregisters a protocol without error', () => {
			const adapter = addMapboxProtocolSupport();
			expect(() => adapter.addProtocol('om', createMockHandler())).not.toThrow();
			expect(() => adapter.removeProtocol('om')).not.toThrow();
		});

		it('removing a non-existent protocol does not throw', () => {
			const adapter = addMapboxProtocolSupport();
			expect(() => adapter.removeProtocol('nonexistent')).not.toThrow();
		});
	});

	// ── createRasterSource ────────────────────────────────────────────────

	describe('createRasterSource', () => {
		it('builds a custom raster source with the protocol tile defaults', () => {
			const adapter = addMapboxProtocolSupport();
			adapter.addProtocol('om', createMockHandler());

			const source = adapter.createRasterSource('om://example.com/tiles.json');

			expect(source.type).toBe('custom');
			expect(source.dataType).toBe('raster');
			expect(source.tileSize).toBe(512);
			expect(source.minzoom).toBe(0);
			expect(source.maxzoom).toBe(12);
			expect(typeof source.loadTile).toBe('function');
		});

		it('forwards options onto the source', () => {
			const adapter = addMapboxProtocolSupport();
			adapter.addProtocol('om', createMockHandler());

			const source = adapter.createRasterSource('om://example.com/tiles.json', {
				maxzoom: 8,
				attribution: '© Test',
				bounds: [-10, -20, 30, 40]
			});

			expect(source.maxzoom).toBe(8);
			expect(source.attribution).toBe('© Test');
			expect(source.bounds).toEqual([-10, -20, 30, 40]);
		});

		it('loadTile resolves the TileJSON, then hands the protocol bitmap to Mapbox', async () => {
			const bitmap = new ImageBitmap();
			const handler = createMockHandler(() => bitmap);
			const adapter = addMapboxProtocolSupport();
			adapter.addProtocol('om', handler);

			const source = adapter.createRasterSource('om://example.com/tiles.json');
			const result = await source.loadTile(
				{ z: 5, x: 10, y: 15 },
				{ signal: new AbortController().signal }
			);

			expect(result).toBe(bitmap);
			expect(handler).toHaveBeenCalledWith(
				{ url: 'om://example.com/tiles.json', type: 'json' },
				expect.any(AbortController),
				undefined
			);
			expect(handler).toHaveBeenLastCalledWith(
				{ url: 'om://example.com/5/10/15', type: 'image' },
				expect.any(AbortController),
				undefined
			);
		});

		it('loadTile resolves to null when the protocol has no data for the tile', async () => {
			const adapter = addMapboxProtocolSupport();
			adapter.addProtocol(
				'om',
				createMockHandler(() => null)
			);

			const source = adapter.createRasterSource('om://example.com/tiles.json');
			const result = await source.loadTile(
				{ z: 5, x: 10, y: 15 },
				{ signal: new AbortController().signal }
			);

			expect(result).toBeNull();
		});

		it("loadTile forwards Mapbox's abort to the handler's controller", async () => {
			let handlerController: AbortController | undefined;
			const handler = vi.fn(async (params: { type: string }, controller: AbortController) => {
				if (params.type === 'json') return { data: TILEJSON };
				handlerController = controller;
				return { data: new ImageBitmap() };
			});
			const adapter = addMapboxProtocolSupport();
			adapter.addProtocol('om', handler);

			const source = adapter.createRasterSource('om://example.com/tiles.json');
			const mapboxAbort = new AbortController();
			await source.loadTile({ z: 5, x: 10, y: 15 }, { signal: mapboxAbort.signal });

			expect(handlerController?.signal.aborted).toBe(false);
			mapboxAbort.abort();
			expect(handlerController?.signal.aborted).toBe(true);
		});

		it('loadTile rejects unsupported tile data', async () => {
			const adapter = addMapboxProtocolSupport();
			adapter.addProtocol(
				'om',
				createMockHandler(() => 'not a bitmap')
			);

			const source = adapter.createRasterSource('om://example.com/tiles.json');
			await expect(
				source.loadTile({ z: 5, x: 10, y: 15 }, { signal: new AbortController().signal })
			).rejects.toThrow('Unsupported raster tile data type');
		});
	});

	// ── addVectorSource ───────────────────────────────────────────────────

	describe('addVectorSource', () => {
		it('adds an exact-geometry GeoJSON source and follows moveend', () => {
			const adapter = addMapboxProtocolSupport();
			adapter.addProtocol('om', createMockHandler());
			const map = createMockMap();

			adapter.addVectorSource(map, 'arrows', 'om://example.com/tiles.json?arrows=true');

			const source = map.sources.get('arrows');
			expect(source?.['type']).toBe('geojson');
			expect(source?.['tolerance']).toBe(0);
			expect(map.listeners.has('moveend')).toBe(true);
		});

		it('fetches the tiles covering the viewport and merges them as GeoJSON with the layer name', async () => {
			const handler = createMockHandler(makeVectorTile);
			const adapter = addMapboxProtocolSupport();
			adapter.addProtocol('om', handler);
			const map = createMockMap(1);

			const handle = adapter.addVectorSource(
				map,
				'arrows',
				'om://example.com/tiles.json?arrows=true'
			);
			await handle.refresh();

			// The world at zoom 1 is 2×2 tiles, requested through the TileJSON's template
			const tileCalls = handler.mock.calls.filter(([params]) => params.type === 'arrayBuffer');
			expect(tileCalls.map(([params]) => params.url).sort()).toEqual([
				'om://example.com/1/0/0',
				'om://example.com/1/0/1',
				'om://example.com/1/1/0',
				'om://example.com/1/1/1'
			]);

			const collection = map.setData.mock.lastCall?.[0] as {
				type: string;
				features: {
					properties: Record<string, unknown>;
					geometry: { type: string; coordinates: number[][] };
				}[];
			};
			expect(collection.type).toBe('FeatureCollection');
			expect(collection.features).toHaveLength(4);
			const feature = collection.features[0];
			expect(feature.properties).toEqual({ layer: 'wind-arrows', value: 3.5 });
			expect(feature.geometry.type).toBe('LineString');
			// Tile 1/0/0 spans lon -180..0, lat 0..85; a point a quarter into the tile
			expect(feature.geometry.coordinates[0][0]).toBeCloseTo(-135, 5);
			expect(feature.geometry.coordinates[0][1]).toBeGreaterThan(0);
		});

		it('skips empty tiles', async () => {
			const adapter = addMapboxProtocolSupport();
			adapter.addProtocol(
				'om',
				createMockHandler(() => new ArrayBuffer(0))
			);
			const map = createMockMap(1);

			const handle = adapter.addVectorSource(map, 'arrows', 'om://example.com/tiles.json');
			await handle.refresh();

			const collection = map.setData.mock.lastCall?.[0] as { features: unknown[] };
			expect(collection.features).toEqual([]);
		});

		it('clamps the tile zoom to the TileJSON range', async () => {
			const handler = createMockHandler(makeVectorTile);
			const adapter = addMapboxProtocolSupport();
			adapter.addProtocol('om', handler);
			const map = createMockMap(15.7);

			const handle = adapter.addVectorSource(map, 'arrows', 'om://example.com/tiles.json', {
				maxzoom: 3
			});
			await handle.refresh();

			const tileCalls = handler.mock.calls.filter(([params]) => params.type === 'arrayBuffer');
			expect(tileCalls.every(([params]) => params.url.includes('/3/'))).toBe(true);
		});

		it('remove() stops following the map and removes the source', () => {
			const adapter = addMapboxProtocolSupport();
			adapter.addProtocol('om', createMockHandler());
			const map = createMockMap();

			const handle = adapter.addVectorSource(map, 'arrows', 'om://example.com/tiles.json');
			handle.remove();

			expect(map.listeners.has('moveend')).toBe(false);
			expect(map.sources.has('arrows')).toBe(false);
		});
	});
});
