/**
 * Unit tests for the Mapbox GL JS adapter (addMapboxProtocolSupport).
 *
 * These tests exercise the adapter's public API in isolation using a minimal
 * mock of the Mapbox GL JS library surface — no real Mapbox dependency required.
 */
import type { MapboxLib } from '../../adapters/mapbox';
import { addMapboxProtocolSupport } from '../../adapters/mapbox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Construct a minimal mock of the Mapbox GL JS namespace. */
const createMockMapbox = (): MapboxLib => {
	class MockRasterSource {
		_options?: Record<string, unknown>;
		options?: Record<string, unknown>;
		url?: string;
		tiles?: string[];
		scheme?: string;
		fire = vi.fn();

		constructor(...args: unknown[]) {
			const opts = (args[1] ?? args[0]) as Record<string, unknown> | undefined;
			this._options = opts ? { ...opts } : {};
			this.url = opts?.['url'] as string | undefined;
		}

		load() {
			/* no-op base */
		}
		loadTile(_tile: unknown, callback: (err?: Error | null) => void) {
			callback(null);
		}
	}

	class MockVectorSource extends MockRasterSource {
		constructor(...args: unknown[]) {
			super(...args);
		}
	}

	return {
		Style: {
			getSourceType(type: 'raster' | 'vector') {
				if (type === 'vector')
					return MockVectorSource as unknown as ReturnType<MapboxLib['Style']['getSourceType']>;
				return MockRasterSource as unknown as ReturnType<MapboxLib['Style']['getSourceType']>;
			}
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
		bounds: [-180, -90, 180, 90],
		...overrides
	};

	return vi.fn().mockResolvedValue({ data: tileJson });
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('addMapboxProtocolSupport', () => {
	let mapboxgl: MapboxLib;

	beforeEach(() => {
		mapboxgl = createMockMapbox();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ── Constructor validation ────────────────────────────────────────────

	describe('constructor validation', () => {
		it('throws when mapboxgl is null', () => {
			expect(() => addMapboxProtocolSupport(null as unknown as MapboxLib)).toThrow(
				'mapboxgl.Style.getSourceType is not available'
			);
		});

		it('returns an adapter with the expected interface', () => {
			const adapter = addMapboxProtocolSupport(mapboxgl);
			expect(adapter).toHaveProperty('addProtocol');
			expect(adapter).toHaveProperty('removeProtocol');
			expect(adapter).toHaveProperty('rasterSourceType');
			expect(adapter).toHaveProperty('vectorSourceType');
			expect(typeof adapter.addProtocol).toBe('function');
			expect(typeof adapter.removeProtocol).toBe('function');
		});
	});

	// ── Protocol registration ─────────────────────────────────────────────

	describe('addProtocol / removeProtocol', () => {
		it('registers and unregisters a protocol without error', () => {
			const adapter = addMapboxProtocolSupport(mapboxgl);
			const handler = createMockHandler();

			expect(() => adapter.addProtocol('om', handler)).not.toThrow();
			expect(() => adapter.removeProtocol('om')).not.toThrow();
		});

		it('allows re-registering a protocol', () => {
			const adapter = addMapboxProtocolSupport(mapboxgl);
			const handler1 = createMockHandler();
			const handler2 = createMockHandler();

			adapter.addProtocol('om', handler1);
			expect(() => adapter.addProtocol('om', handler2)).not.toThrow();
		});

		it('removing a non-existent protocol does not throw', () => {
			const adapter = addMapboxProtocolSupport(mapboxgl);
			expect(() => adapter.removeProtocol('nonexistent')).not.toThrow();
		});
	});

	// ── Source types ──────────────────────────────────────────────────────

	describe('rasterSourceType', () => {
		it('is a constructor function', () => {
			const adapter = addMapboxProtocolSupport(mapboxgl);
			expect(typeof adapter.rasterSourceType).toBe('function');
		});

		it('can be instantiated', () => {
			const adapter = addMapboxProtocolSupport(mapboxgl);
			// Mapbox passes (id, options, dispatcher, eventedParent) to source constructors
			const source = new adapter.rasterSourceType('test-id', {
				url: 'om://example.com/tiles.json',
				type: 'raster'
			});
			expect(source).toBeDefined();
			expect(typeof source.load).toBe('function');
			expect(typeof source.loadTile).toBe('function');
		});
	});

	describe('vectorSourceType', () => {
		it('is a constructor function', () => {
			const adapter = addMapboxProtocolSupport(mapboxgl);
			expect(typeof adapter.vectorSourceType).toBe('function');
		});

		it('can be instantiated', () => {
			const adapter = addMapboxProtocolSupport(mapboxgl);
			const source = new adapter.vectorSourceType('test-id', {
				url: 'om://example.com/tiles.json',
				type: 'vector'
			});
			expect(source).toBeDefined();
			expect(typeof source.load).toBe('function');
			expect(typeof source.loadTile).toBe('function');
		});
	});

	// ── load() with custom protocol ──────────────────────────────────────

	describe('source load()', () => {
		it('raster source load() calls the registered protocol handler for TileJSON', async () => {
			const adapter = addMapboxProtocolSupport(mapboxgl);
			const handler = createMockHandler();
			adapter.addProtocol('om', handler);

			const source = new adapter.rasterSourceType('test-id', {
				url: 'om://example.com/tiles.json',
				type: 'raster'
			});
			source.load();

			// Wait for async handler resolution
			await vi.waitFor(() => {
				expect(handler).toHaveBeenCalledTimes(1);
			});

			expect(handler).toHaveBeenCalledWith(
				{ url: 'om://example.com/tiles.json', type: 'json' },
				expect.any(AbortController),
				undefined
			);
		});

		it('vector source load() calls the registered protocol handler for TileJSON', async () => {
			const adapter = addMapboxProtocolSupport(mapboxgl);
			const handler = createMockHandler();
			adapter.addProtocol('om', handler);

			const source = new adapter.vectorSourceType('test-id', {
				url: 'om://example.com/tiles.json',
				type: 'vector'
			});
			source.load();

			await vi.waitFor(() => {
				expect(handler).toHaveBeenCalledTimes(1);
			});
		});

		it('load() with no registered handler fires an error event', () => {
			const adapter = addMapboxProtocolSupport(mapboxgl);
			// Register nothing

			const source = new adapter.rasterSourceType('test-id', {
				url: 'om://example.com/tiles.json',
				type: 'raster'
			});

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			source.load();

			expect(consoleSpy).toHaveBeenCalledWith(
				'[mapbox-adapter] No handler registered for protocol: "om"'
			);
			expect(source.fire).toHaveBeenCalledWith('error', {
				error: expect.objectContaining({
					message: '[mapbox-adapter] No handler registered for protocol: "om"'
				})
			});
			consoleSpy.mockRestore();
		});

		it('load() patches source options with TileJSON metadata', async () => {
			const adapter = addMapboxProtocolSupport(mapboxgl);
			const handler = createMockHandler({
				tiles: ['om://example.com/{z}/{x}/{y}.png'],
				bounds: [-10, -20, 30, 40],
				minzoom: 2,
				maxzoom: 10,
				attribution: '© Test'
			});
			adapter.addProtocol('om', handler);

			const source = new adapter.rasterSourceType('test-id', {
				url: 'om://example.com/tiles.json',
				type: 'raster'
			});
			source.load();

			await vi.waitFor(() => {
				expect(handler).toHaveBeenCalled();
			});

			// The handler resolves TileJSON and patches _options
			const opts = source._options ?? source.options;
			expect(opts?.['tiles']).toEqual(['om://example.com/{z}/{x}/{y}.png']);
			expect(opts?.['bounds']).toEqual([-10, -20, 30, 40]);
			expect(opts?.['minzoom']).toBe(2);
			expect(opts?.['maxzoom']).toBe(10);
			expect(opts?.['url']).toBeUndefined();
		});
	});

	// ── Error handling in load() ──────────────────────────────────────────

	describe('load() error handling', () => {
		it('fires error event when handler returns no data', async () => {
			const adapter = addMapboxProtocolSupport(mapboxgl);
			const handler = vi.fn().mockResolvedValue({ data: null });
			adapter.addProtocol('om', handler);

			const source = new adapter.rasterSourceType('test-id', {
				url: 'om://example.com/tiles.json',
				type: 'raster'
			});

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			source.load();

			await vi.waitFor(() => {
				expect(consoleSpy).toHaveBeenCalled();
			});

			consoleSpy.mockRestore();
		});

		it('fires error event when handler rejects', async () => {
			const adapter = addMapboxProtocolSupport(mapboxgl);
			const handler = vi.fn().mockRejectedValue(new Error('Network error'));
			adapter.addProtocol('om', handler);

			const source = new adapter.rasterSourceType('test-id', {
				url: 'om://example.com/tiles.json',
				type: 'raster'
			});

			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			source.load();

			await vi.waitFor(() => {
				expect(consoleSpy).toHaveBeenCalledWith(
					'[mapbox-adapter] Error fetching TileJSON:',
					expect.any(Error)
				);
			});

			consoleSpy.mockRestore();
		});
	});
});
