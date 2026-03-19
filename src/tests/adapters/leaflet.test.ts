/**
 * Unit tests for the Leaflet adapter (addLeafletProtocolSupport).
 *
 * These tests exercise the adapter's public API in isolation using a minimal
 * mock of the Leaflet library surface — no real Leaflet dependency required.
 */
import type { LeafletLib } from '../../adapters/leaflet';
import { addLeafletProtocolSupport } from '../../adapters/leaflet';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Shape exposed by the mock GridLayer so tests can inspect stored options. */
interface MockLayerInstance {
	_options: Record<string, unknown>;
	_proto: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Construct a minimal mock of the Leaflet namespace. */
const createMockLeaflet = (): LeafletLib => {
	return {
		GridLayer: {
			extend(proto: Record<string, unknown>) {
				// Return a constructor that stores the proto and options
				return class MockGridLayer {
					_proto = proto;
					_options: Record<string, unknown>;
					_tiles: Record<string, unknown> = {};
					_tileZoom: number | undefined = undefined;
					fire = vi.fn();
					constructor(options: Record<string, unknown> = {}) {
						this._options = options;
					}
					getTileSize() {
						return { x: 256, y: 256 };
					}
				} as unknown as ReturnType<LeafletLib['GridLayer']['extend']>;
			},
			prototype: {
				_removeTile: vi.fn(),
				_abortLoading: vi.fn()
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
		...overrides
	};

	return vi.fn().mockResolvedValue({ data: tileJson });
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('addLeafletProtocolSupport', () => {
	let L: LeafletLib;

	beforeEach(() => {
		L = createMockLeaflet();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	// ── Constructor validation ────────────────────────────────────────────

	describe('constructor validation', () => {
		it('throws when L is null', () => {
			expect(() => addLeafletProtocolSupport(null as unknown as LeafletLib)).toThrow(
				'L.GridLayer is not available'
			);
		});

		it('returns an adapter with the expected interface', () => {
			const adapter = addLeafletProtocolSupport(L);
			expect(adapter).toHaveProperty('addProtocol');
			expect(adapter).toHaveProperty('removeProtocol');
			expect(adapter).toHaveProperty('createTileLayer');
			expect(adapter).toHaveProperty('createVectorTileLayer');
			expect(typeof adapter.addProtocol).toBe('function');
			expect(typeof adapter.removeProtocol).toBe('function');
			expect(typeof adapter.createTileLayer).toBe('function');
			expect(typeof adapter.createVectorTileLayer).toBe('function');
		});
	});

	// ── Protocol registration ─────────────────────────────────────────────

	describe('addProtocol / removeProtocol', () => {
		it('registers and unregisters a protocol without error', () => {
			const adapter = addLeafletProtocolSupport(L);
			const handler = createMockHandler();

			expect(() => adapter.addProtocol('om', handler)).not.toThrow();
			expect(() => adapter.removeProtocol('om')).not.toThrow();
		});

		it('allows re-registering a protocol with a different handler', () => {
			const adapter = addLeafletProtocolSupport(L);
			const handler1 = createMockHandler();
			const handler2 = createMockHandler();

			adapter.addProtocol('om', handler1);
			expect(() => adapter.addProtocol('om', handler2)).not.toThrow();
		});

		it('removing a non-existent protocol does not throw', () => {
			const adapter = addLeafletProtocolSupport(L);
			expect(() => adapter.removeProtocol('nonexistent')).not.toThrow();
		});
	});

	// ── createTileLayer ───────────────────────────────────────────────────

	describe('createTileLayer', () => {
		it('returns a layer instance', () => {
			const adapter = addLeafletProtocolSupport(L);
			adapter.addProtocol('om', createMockHandler());

			const layer = adapter.createTileLayer('om://example.com/tiles.json');
			expect(layer).toBeDefined();
		});

		it('passes through leaflet options including defaults', () => {
			const adapter = addLeafletProtocolSupport(L);
			adapter.addProtocol('om', createMockHandler());

			const layer = adapter.createTileLayer('om://example.com/tiles.json', {
				opacity: 0.5,
				zIndex: 10
			}) as unknown as MockLayerInstance;

			// The mock GridLayer stores options in _options
			expect(layer._options.tileSize).toBe(256);
			expect(layer._options.opacity).toBe(0.5);
			expect(layer._options.zIndex).toBe(10);
		});

		it('custom options override defaults', () => {
			const adapter = addLeafletProtocolSupport(L);
			adapter.addProtocol('om', createMockHandler());

			const layer = adapter.createTileLayer('om://example.com/tiles.json', {
				tileSize: 512
			}) as unknown as MockLayerInstance;

			expect(layer._options.tileSize).toBe(512);
		});
	});

	// ── createVectorTileLayer ─────────────────────────────────────────────

	describe('createVectorTileLayer', () => {
		it('returns a layer instance', () => {
			const adapter = addLeafletProtocolSupport(L);
			adapter.addProtocol('om', createMockHandler());

			const layer = adapter.createVectorTileLayer('om://example.com/tiles.json');
			expect(layer).toBeDefined();
		});

		it('passes through options minus the style key', () => {
			const adapter = addLeafletProtocolSupport(L);
			adapter.addProtocol('om', createMockHandler());

			const customStyle = () => ({ strokeStyle: 'red', lineWidth: 2 });
			const layer = adapter.createVectorTileLayer('om://example.com/tiles.json', {
				style: customStyle,
				opacity: 0.8
			}) as unknown as MockLayerInstance;

			// style should not be forwarded to GridLayer options
			expect(layer._options.style).toBeUndefined();
			expect(layer._options.opacity).toBe(0.8);
			expect(layer._options.tileSize).toBe(256);
		});

		it('uses default vector style when no style is provided', () => {
			const adapter = addLeafletProtocolSupport(L);
			adapter.addProtocol('om', createMockHandler());

			// Should not throw
			const layer = adapter.createVectorTileLayer('om://example.com/tiles.json');
			expect(layer).toBeDefined();
		});
	});
});
