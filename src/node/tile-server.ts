/**
 * A tile server request handler for `node:http` (or any framework that hands
 * over Node's request and response), serving om:// tiles as PNG (raster) or
 * PBF (vector). The client picks the data per request through the path, and
 * the render options through the query, which goes to the protocol untouched:
 *
 *   /tiles/{domain}/{run}/{time}/{variable}/{z}/{x}/{y}.png?colorscale=…&interpolation=…
 *   /tiles/{domain}/{run}/{time}/{variable}/{z}/{x}/{y}.pbf?arrows=true&contours=true&intervals=2
 *
 * `run` is `latest` with `time` a protocol time step (`current_time_1H`,
 * `current_time_-2H`, `valid_times_3`, …), or a model run like
 * `2026-10-07T0600Z` with `time` the valid time `2026-10-07T1200`. Tiles of a
 * model run never change, so they are kept in memory and marked immutable for
 * browsers and CDNs; `latest` tiles are kept for a minute, as long as the
 * protocol caches `latest.json`. Identical requests under way render once.
 */
import { domainOptions } from '../domains';
import { type OmProtocol, defaultOmProtocolSettings } from '../om-protocol-core';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { encodePng } from './png';

import type { OmProtocolSettings, RgbaTile } from '../types';

export interface TileServerOptions {
	/** The protocol handler rendering the tiles. @default the Node `omProtocol` */
	protocol: OmProtocol;
	/** Where the `data_spatial` files live. @default https://openmeteo.s3.amazonaws.com/data_spatial */
	dataUrl?: string;
	/**
	 * How many variables keep their data loaded (the protocol's
	 * `maxStatesWithData`); its default of 2 suits a map, not a server
	 * answering for many. @default 8
	 */
	maxVariables?: number;
	/** Rendered tiles kept in memory. @default 1000 */
	cacheSize?: number;
	/** Seconds a `latest` tile is cached, by the server and by clients. @default 60 */
	latestMaxAge?: number;
	/** Protocol settings beyond `maxVariables` (colour scales, domains, derivation rules). */
	settings?: Partial<OmProtocolSettings>;
}

export type TileHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const DEFAULT_DATA_URL = 'https://openmeteo.s3.amazonaws.com/data_spatial';

const TILE_PATH =
	/^\/tiles\/(?<domain>[\w-]+)\/(?<run>latest|\d{4}-\d{2}-\d{2}T\d{4}Z)\/(?<time>[\w+-]+)\/(?<variable>[\w-]+)\/(?<z>\d+)\/(?<x>\d+)\/(?<y>\d+)\.(?<format>png|pbf)$/;

interface TileRoute {
	domain: string;
	run: string;
	time: string;
	variable: string;
	z: string;
	x: string;
	y: string;
	format: 'png' | 'pbf';
}

/** The route of a request path, or undefined when it is not a tile path. */
export const parseTileRoute = (pathname: string): TileRoute | undefined =>
	TILE_PATH.exec(pathname)?.groups as TileRoute | undefined;

/** The protocol URL for a route: the metadata file for `latest`, the model run's file otherwise. */
export const tileUrl = (route: TileRoute, query: string, dataUrl = DEFAULT_DATA_URL): string => {
	const { domain, run, time, variable, z, x, y } = route;
	// The tile coordinates follow the last query parameter, and the protocol
	// drops `time_step` once resolved, so that one must not be last
	const params = new URLSearchParams(run === 'latest' ? { time_step: time } : {});
	params.set('variable', variable);
	for (const [key, value] of new URLSearchParams(query)) {
		if (key !== 'time_step' && key !== 'variable') params.set(key, value);
	}
	const file =
		run === 'latest'
			? `${domain}/latest.json`
			: `${domain}/${run.slice(0, 10).replaceAll('-', '/')}/${run.slice(11)}/${time}.om`;
	return `om://${dataUrl}/${file}?${params}/${z}/${x}/${y}`;
};

interface RenderedTile {
	status: 200 | 204;
	body?: Uint8Array;
	contentType?: string;
	expires: number;
}

/**
 * Build the request handler. Pass it to `createServer` from `node:http`, or
 * mount it in Express, Fastify or similar; it answers everything under
 * `/tiles/` and 404s the rest.
 */
export const createTileHandler = (options: TileServerOptions): TileHandler => {
	const {
		protocol,
		dataUrl = DEFAULT_DATA_URL,
		maxVariables = 8,
		cacheSize = 1000,
		latestMaxAge = 60
	} = options;
	const settings: OmProtocolSettings = {
		...defaultOmProtocolSettings,
		...options.settings,
		maxStatesWithData: maxVariables
	};

	// Rendered responses by request URL, least recently used first, and the
	// renders under way so a burst of identical requests renders once
	const cache = new Map<string, RenderedTile>();
	const inflight = new Map<string, Promise<RenderedTile>>();

	const render = async (route: TileRoute, url: string): Promise<RenderedTile> => {
		const expires = route.run === 'latest' ? Date.now() + latestMaxAge * 1000 : Infinity;
		const type = route.format === 'png' ? 'image' : 'arrayBuffer';
		const { data } = await protocol({ url, type }, new AbortController(), settings);
		if (route.format === 'png') {
			// Nothing to draw: the tile lies outside the domain
			if (data instanceof ArrayBuffer) return { status: 204, expires };
			return {
				status: 200,
				body: encodePng(data as RgbaTile),
				contentType: 'image/png',
				expires
			};
		}
		return {
			status: 200,
			body: new Uint8Array(data as ArrayBuffer),
			contentType: 'application/x-protobuf',
			expires
		};
	};

	const getTile = (route: TileRoute, key: string, url: string): Promise<RenderedTile> => {
		const cached = cache.get(key);
		if (cached && cached.expires > Date.now()) {
			cache.delete(key);
			cache.set(key, cached);
			return Promise.resolve(cached);
		}
		let pending = inflight.get(key);
		if (!pending) {
			pending = render(route, url)
				.then((tile) => {
					cache.set(key, tile);
					if (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
					return tile;
				})
				.finally(() => inflight.delete(key));
			inflight.set(key, pending);
		}
		return pending;
	};

	return async (req, res) => {
		// Map pages on other origins (a Cesium or MapLibre app) fetch the tiles cross-origin
		res.setHeader('access-control-allow-origin', '*');
		const { pathname, search } = new URL(req.url ?? '/', 'http://localhost');
		const route = parseTileRoute(pathname);
		if (!route) {
			res.writeHead(404).end('Use /tiles/{domain}/{run}/{time}/{variable}/{z}/{x}/{y}.png or .pbf');
			return;
		}
		const domains = settings.domainOptions ?? domainOptions;
		if (!domains.some((domain) => domain.value === route.domain)) {
			res.writeHead(404).end(`Unknown domain ${route.domain}`);
			return;
		}
		try {
			const tile = await getTile(route, pathname + search, tileUrl(route, search, dataUrl));
			res.setHeader(
				'cache-control',
				route.run === 'latest'
					? `public, max-age=${latestMaxAge}`
					: 'public, max-age=31536000, immutable'
			);
			if (tile.status === 204 || !tile.body) {
				res.writeHead(204).end();
				return;
			}
			res.writeHead(200, { 'content-type': tile.contentType!, 'content-length': tile.body.length });
			res.end(tile.body);
		} catch (error) {
			console.error(`${req.url}:`, error);
			res.writeHead(500).end(String(error));
		}
	};
};
