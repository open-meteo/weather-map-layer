/**
 * Unit tests for the OpenLayers adapter (addOpenLayersProtocolSupport).
 *
 * These tests exercise the adapter's public API in isolation using a minimal
 * mock of the OpenLayers library surface — no real OL dependency required.
 */
import type { OlLib } from '../../adapters/openlayers';
import { addOpenLayersProtocolSupport } from '../../adapters/openlayers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Shape of the mock DataTile/VectorTile instances so tests can inspect stored state. */
interface MockSourceInstance {
	_options: Record<string, unknown>;
	_attributions: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Construct a minimal mock of the OpenLayers namespace. */
const createMockOl = (): OlLib => {
	class MockDataTile {
		_options: Record<string, unknown>;
		_attributions: string | null = null;

		constructor(options: Record<string, unknown>) {
			this._options = options;
		}

		setAttributions(attr: string) {
			this._attributions = attr;
		}
	}

	class MockVectorTile {
		_options: Record<string, unknown>;
		_attributions: string | null = null;

		constructor(options: Record<string, unknown>) {
			this._options = options;
		}

		setAttributions(attr: string) {
			this._attributions = attr;
		}

		getTileGrid() {
			return { getTileCoordExtent: () => [0, 0, 256, 256] };
		}

		getProjection() {
			return 'EPSG:3857';
		}

		on(_event: string, _listener: (...args: unknown[]) => void) {}
	}

	class MockMVT {
		readFeatures() {
			return [];
		}
		readProjection() {
			return 'EPSG:3857';
		}
	}

	return {
		source: {
			DataTile: MockDataTile as unknown as OlLib['source']['DataTile'],
			VectorTile: MockVectorTile as unknown as OlLib['source']['VectorTile']
		},
		format: {
			MVT: MockMVT as unknown as NonNullable<OlLib['format']>['MVT']
		}
	};
};

/** Create a mock protocol handler that returns predictable TileJSON. */
const createMockHandler = (overrides: Record<string, unknown> = {}) => {
	const tileJson = {
		tiles: ['om://example.com/{z}/{x}/{y}.png'],
		attribution: '© Open-Meteo',
		minzoom: 0,
		maxzoom: 12,
		...overrides
	};

	return vi.fn().mockResolvedValue({ data: tileJson });
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('addOpenLayersProtocolSupport', () => {
	let ol: OlLib;

	beforeEach(() => {
		ol = createMockOl();
		// Stub browser globals unavailable in Node.
		vi.stubGlobal('ImageData', class ImageData {});
		vi.stubGlobal('ImageBitmap', class ImageBitmap {});
		vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 256, height: 256 }));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	// ── Constructor validation ────────────────────────────────────────────

	describe('constructor validation', () => {
		it('throws when ol is null', () => {
			expect(() => addOpenLayersProtocolSupport(null as unknown as OlLib)).toThrow(
				'ol.source.DataTile and ol.source.VectorTile must be available'
			);
		});

		it('returns an adapter with the expected interface', () => {
			const adapter = addOpenLayersProtocolSupport(ol);
			expect(adapter).toHaveProperty('addProtocol');
			expect(adapter).toHaveProperty('removeProtocol');
			expect(adapter).toHaveProperty('createRasterSource');
			expect(adapter).toHaveProperty('createVectorTileSource');
			expect(typeof adapter.addProtocol).toBe('function');
			expect(typeof adapter.removeProtocol).toBe('function');
			expect(typeof adapter.createRasterSource).toBe('function');
			expect(typeof adapter.createVectorTileSource).toBe('function');
		});
	});

	// ── Protocol registration ─────────────────────────────────────────────

	describe('addProtocol / removeProtocol', () => {
		it('registers and unregisters a protocol without error', () => {
			const adapter = addOpenLayersProtocolSupport(ol);
			const handler = createMockHandler();

			expect(() => adapter.addProtocol('om', handler)).not.toThrow();
			expect(() => adapter.removeProtocol('om')).not.toThrow();
		});

		it('allows re-registering a protocol', () => {
			const adapter = addOpenLayersProtocolSupport(ol);
			const handler1 = createMockHandler();
			const handler2 = createMockHandler();

			adapter.addProtocol('om', handler1);
			expect(() => adapter.addProtocol('om', handler2)).not.toThrow();
		});

		it('removing a non-existent protocol does not throw', () => {
			const adapter = addOpenLayersProtocolSupport(ol);
			expect(() => adapter.removeProtocol('nonexistent')).not.toThrow();
		});
	});

	// ── createRasterSource ────────────────────────────────────────────────

	describe('createRasterSource', () => {
		it('returns an ol.source.DataTile instance', () => {
			const adapter = addOpenLayersProtocolSupport(ol);
			adapter.addProtocol('om', createMockHandler());

			const source = adapter.createRasterSource('om://example.com/tiles.json');
			expect(source).toBeDefined();
		});

		it('passes through OL options including defaults', () => {
			const adapter = addOpenLayersProtocolSupport(ol);
			adapter.addProtocol('om', createMockHandler());

			const source = adapter.createRasterSource('om://example.com/tiles.json', {
				transition: 200
			}) as unknown as MockSourceInstance;

			expect(source._options.transition).toBe(200);
			expect(source._options.wrapX).toBe(true);
			expect(source._options.tileSize).toBe(256);
		});

		it('custom options override defaults', () => {
			const adapter = addOpenLayersProtocolSupport(ol);
			adapter.addProtocol('om', createMockHandler());

			const source = adapter.createRasterSource('om://example.com/tiles.json', {
				tileSize: 512
			}) as unknown as MockSourceInstance;

			expect(source._options.tileSize).toBe(512);
		});

		it('loader calls the protocol handler for tile data', async () => {
			const adapter = addOpenLayersProtocolSupport(ol);
			const handler = vi
				.fn()
				.mockResolvedValueOnce({
					data: {
						tiles: ['om://example.com/{z}/{x}/{y}.png'],
						attribution: '© Test'
					}
				})
				.mockResolvedValueOnce({
					data: new ImageBitmap()
				});
			adapter.addProtocol('om', handler);

			const source = adapter.createRasterSource(
				'om://example.com/tiles.json'
			) as unknown as MockSourceInstance;
			const loader = source._options.loader as (...args: unknown[]) => Promise<unknown>;

			// Eager prefetch consumed the first handler call (TileJSON).
			// Wait for it to resolve so the cache is warm before the tile load.
			await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

			// Now the tile load only needs the image call.
			await loader(5, 10, 15, { signal: new AbortController().signal });

			// 1 TileJSON (eager) + 1 tile image
			expect(handler).toHaveBeenCalledTimes(2);
		});
	});

	// ── createVectorTileSource ────────────────────────────────────────────

	describe('createVectorTileSource', () => {
		it('throws if ol.format.MVT is not available', () => {
			const olNoMvt = { ...ol, format: undefined };
			const adapter = addOpenLayersProtocolSupport(olNoMvt as OlLib);
			adapter.addProtocol('om', createMockHandler());

			expect(() => adapter.createVectorTileSource('om://example.com/tiles.json')).toThrow(
				'ol.format.MVT is not available'
			);
		});

		it('returns an ol.source.VectorTile instance', () => {
			const adapter = addOpenLayersProtocolSupport(ol);
			adapter.addProtocol('om', createMockHandler());

			const source = adapter.createVectorTileSource('om://example.com/tiles.json');
			expect(source).toBeDefined();
		});

		it('passes through OL options including defaults', () => {
			const adapter = addOpenLayersProtocolSupport(ol);
			adapter.addProtocol('om', createMockHandler());

			const source = adapter.createVectorTileSource('om://example.com/tiles.json', {
				transition: 100
			}) as unknown as MockSourceInstance;

			expect(source._options.transition).toBe(100);
			expect(source._options.wrapX).toBe(true);
		});

		it('accepts custom MVT format via options', () => {
			const adapter = addOpenLayersProtocolSupport(ol);
			adapter.addProtocol('om', createMockHandler());

			const customFormat = {
				readFeatures: () => [],
				readProjection: () => 'EPSG:4326'
			};

			const source = adapter.createVectorTileSource('om://example.com/tiles.json', {
				format: customFormat
			}) as unknown as MockSourceInstance;

			// The custom format should be used, and not forwarded in restOlOptions
			expect(source._options.format).toBe(customFormat);
		});
	});

	// ── Error handling ────────────────────────────────────────────────────

	describe('error handling', () => {
		it('raster loader rejects when no handler is registered', async () => {
			const adapter = addOpenLayersProtocolSupport(ol);

			const source = adapter.createRasterSource(
				'om://example.com/tiles.json'
			) as unknown as MockSourceInstance;
			const loader = source._options.loader as (...args: unknown[]) => Promise<unknown>;

			await expect(loader(1, 0, 0, { signal: new AbortController().signal })).rejects.toThrow(
				'[openlayers-adapter] No handler registered for protocol: "om"'
			);
		});

		it('raster loader rejects when TileJSON has no tiles', async () => {
			const adapter = addOpenLayersProtocolSupport(ol);
			const handler = vi.fn().mockResolvedValue({ data: { tiles: [] } });
			adapter.addProtocol('om', handler);

			const source = adapter.createRasterSource(
				'om://example.com/tiles.json'
			) as unknown as MockSourceInstance;
			const loader = source._options.loader as (...args: unknown[]) => Promise<unknown>;

			await expect(loader(1, 0, 0, { signal: new AbortController().signal })).rejects.toThrow(
				'TileJSON contains no tile URLs'
			);
		});

		it('raster loader rejects when handler returns no data', async () => {
			const adapter = addOpenLayersProtocolSupport(ol);
			const handler = vi.fn().mockResolvedValue({ data: null });
			adapter.addProtocol('om', handler);

			const source = adapter.createRasterSource(
				'om://example.com/tiles.json'
			) as unknown as MockSourceInstance;
			const loader = source._options.loader as (...args: unknown[]) => Promise<unknown>;

			await expect(loader(1, 0, 0, { signal: new AbortController().signal })).rejects.toThrow(
				'Protocol handler returned no data for TileJSON'
			);
		});
	});
});
