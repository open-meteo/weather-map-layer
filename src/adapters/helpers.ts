import type { OmProtocolSettings } from '../types';
import type { ProtocolHandler, RegisteredProtocol } from './types';

/** Extract the protocol prefix from a URL, e.g. "om" from "om://…". Returns null if not found. */
export const extractProtocol = (url: string): string | null => {
	const idx = url.indexOf('://');
	return idx !== -1 ? url.substring(0, idx) : null;
};

/** Substitute {z}/{x}/{y} placeholders in a tile URL template. */
export const buildTileUrl = (template: string, z: number, x: number, y: number): string => {
	return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
};

/** Resolved TileJSON data returned by the lazy resolver. */
export interface TileJsonResolved {
	tileTemplate: string;
	tileJson: Record<string, unknown>;
}

/** A protocol registry that manages handlers and provides TileJSON resolution. */
export interface ProtocolRegistry {
	add(protocol: string, handler: ProtocolHandler, settings?: OmProtocolSettings): void;
	remove(protocol: string): void;
	has(protocol: string): boolean;
	get(protocol: string): RegisteredProtocol;
	makeTileJsonResolver(tileJsonUrl: string): () => Promise<TileJsonResolved>;
}

/**
 * Create a protocol registry that manages handler registration and TileJSON resolution.
 *
 * @param adapterName - Label used in error messages, e.g. `"leaflet-adapter"`.
 */
export const createProtocolRegistry = (adapterName: string): ProtocolRegistry => {
	const protocols = new Map<string, RegisteredProtocol>();

	const get = (protocol: string): RegisteredProtocol => {
		const entry = protocols.get(protocol);
		if (!entry) {
			throw new Error(`[${adapterName}] No handler registered for protocol: "${protocol}"`);
		}
		return entry;
	};

	/**
	 * Build a lazy TileJSON resolver for a given om:// URL.
	 *
	 * The returned function can be called many times; only one network request
	 * is made.  Once resolved the result is cached indefinitely.
	 */
	const makeTileJsonResolver = (tileJsonUrl: string): (() => Promise<TileJsonResolved>) => {
		let cached: TileJsonResolved | null = null;
		let pending: Promise<TileJsonResolved> | null = null;

		return () => {
			if (cached) return Promise.resolve(cached);
			if (pending) return pending;

			const protocol = extractProtocol(tileJsonUrl)!;
			const { handler, settings } = get(protocol);

			pending = handler({ url: tileJsonUrl, type: 'json' }, new AbortController(), settings)
				.then((response) => {
					if (!response?.data) {
						throw new Error(
							`[${adapterName}] Protocol handler returned no data for TileJSON: ${tileJsonUrl}`
						);
					}
					const tileJson = response.data as Record<string, unknown>;
					const tiles = tileJson['tiles'] as string[] | undefined;
					if (!tiles?.length) {
						throw new Error(`[${adapterName}] TileJSON contains no tile URLs: ${tileJsonUrl}`);
					}
					cached = { tileTemplate: tiles[0], tileJson };
					pending = null;
					return cached;
				})
				.catch((err) => {
					pending = null; // allow retry on next call
					throw err;
				});

			return pending;
		};
	};

	return {
		add: (protocol, handler, settings) => protocols.set(protocol, { handler, settings }),
		remove: (protocol) => protocols.delete(protocol),
		has: (protocol) => protocols.has(protocol),
		get,
		makeTileJsonResolver
	};
};
