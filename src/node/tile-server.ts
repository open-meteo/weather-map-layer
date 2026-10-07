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
 *
 * Raster tiles past the domain's maximum zoom (`domainMaxZoom`: where a tile
 * pixel is finer than the grid) are not rendered but magnified from the tile
 * at that zoom, as a map client overzooms. The TileJSON at
 * `/tiles/{domain}/{run}/{time}/{variable}.json` tells clients that zoom, so
 * they stop requesting tiles there in the first place.
 */
import { domainOptions } from '../domains';
import { domainMaxZoom } from '../grids/max-zoom';
import { type OmProtocol, defaultOmProtocolSettings } from '../om-protocol-core';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { overzoomTile } from './overzoom';
import { encodePng } from './png';

import type { Domain, OmProtocolSettings, RgbaTile, TileJSON } from '../types';

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

const TILEJSON_PATH =
	/^\/tiles\/(?<domain>[\w-]+)\/(?<run>latest|\d{4}-\d{2}-\d{2}T\d{4}Z)\/(?<time>[\w+-]+)\/(?<variable>[\w-]+)\.json$/;

/** The data part of a route: a TileJSON request has no tile coordinates. */
type DataRoute = Omit<TileRoute, 'z' | 'x' | 'y' | 'format'>;

/** The route of a request path, or undefined when it is not a tile path. */
export const parseTileRoute = (pathname: string): TileRoute | undefined =>
	TILE_PATH.exec(pathname)?.groups as TileRoute | undefined;

/** The route of a TileJSON request path, or undefined when it is not one. */
export const parseTileJsonRoute = (pathname: string): DataRoute | undefined =>
	TILEJSON_PATH.exec(pathname)?.groups as DataRoute | undefined;

/** The protocol URL for a route: the metadata file for `latest`, the model run's file otherwise. */
export const tileUrl = (
	route: DataRoute & Partial<Pick<TileRoute, 'z' | 'x' | 'y'>>,
	query: string,
	dataUrl = DEFAULT_DATA_URL
): string => {
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
	const tile = z === undefined ? '' : `/${z}/${x}/${y}`;
	return `om://${dataUrl}/${file}?${params}${tile}`;
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

	const render = async (
		route: TileRoute,
		domain: Domain,
		search: string
	): Promise<RenderedTile> => {
		const expires = route.run === 'latest' ? Date.now() + latestMaxAge * 1000 : Infinity;
		if (route.format === 'png') {
			// Past the domain's maximum zoom the tile is magnified from the tile
			// at that zoom, as a map client would do with it
			const z = Number(route.z);
			const levels = Math.max(0, z - domainMaxZoom(domain, settings.domainOptions));
			const x = Number(route.x) >> levels;
			const y = Number(route.y) >> levels;
			const url = tileUrl(
				{ ...route, z: String(z - levels), x: String(x), y: String(y) },
				search,
				dataUrl
			);
			const { data } = await protocol({ url, type: 'image' }, new AbortController(), settings);
			// Nothing to draw: the tile lies outside the domain
			if (data instanceof ArrayBuffer) return { status: 204, expires };
			const tile =
				levels === 0
					? (data as RgbaTile)
					: overzoomTile(
							data as RgbaTile,
							levels,
							Number(route.x) - (x << levels),
							Number(route.y) - (y << levels)
						);
			return { status: 200, body: encodePng(tile), contentType: 'image/png', expires };
		}
		const url = tileUrl(route, search, dataUrl);
		const { data } = await protocol({ url, type: 'arrayBuffer' }, new AbortController(), settings);
		return {
			status: 200,
			body: new Uint8Array(data as ArrayBuffer),
			contentType: 'application/x-protobuf',
			expires
		};
	};

	const getTile = (
		route: TileRoute,
		domain: Domain,
		key: string,
		search: string
	): Promise<RenderedTile> => {
		const cached = cache.get(key);
		if (cached && cached.expires > Date.now()) {
			cache.delete(key);
			cache.set(key, cached);
			return Promise.resolve(cached);
		}
		let pending = inflight.get(key);
		if (!pending) {
			pending = render(route, domain, search)
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

	/**
	 * The protocol's TileJSON for the data, with the tiles template pointing
	 * back at this server. `maxzoom` is the domain's for raster tiles, so a
	 * client stops requesting tiles past it; a `.pbf` template needs the vector
	 * query, which is what makes the protocol answer the full range.
	 */
	const tileJson = async (
		req: IncomingMessage,
		res: ServerResponse,
		route: DataRoute,
		search: string
	): Promise<void> => {
		const params = new URLSearchParams(search);
		const format = params.get('format') === 'pbf' ? 'pbf' : 'png';
		params.delete('format');
		const query = params.size > 0 ? `?${params}` : '';
		try {
			const { data } = await protocol(
				{ url: tileUrl(route, query, dataUrl), type: 'json' },
				new AbortController(),
				settings
			);
			const { domain, run, time, variable } = route;
			const base = `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers.host ?? 'localhost'}`;
			const tileJson: TileJSON = {
				...(data as TileJSON),
				tiles: [`${base}/tiles/${domain}/${run}/${time}/${variable}/{z}/{x}/{y}.${format}${query}`]
			};
			res.setHeader('cache-control', `public, max-age=${latestMaxAge}`);
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(tileJson));
		} catch (error) {
			console.error(`${req.url}:`, error);
			res.writeHead(500).end(String(error));
		}
	};

	return async (req, res) => {
		// Map pages on other origins (a Cesium or MapLibre app) fetch the tiles cross-origin
		res.setHeader('access-control-allow-origin', '*');
		const { pathname, search } = new URL(req.url ?? '/', 'http://localhost');
		const tileRoute = parseTileRoute(pathname);
		const route = tileRoute ?? parseTileJsonRoute(pathname);
		if (!route) {
			res
				.writeHead(404)
				.end(
					'Use /tiles/{domain}/{run}/{time}/{variable}/{z}/{x}/{y}.png or .pbf, or /tiles/{domain}/{run}/{time}/{variable}.json'
				);
			return;
		}
		const domains = settings.domainOptions ?? domainOptions;
		const domain = domains.find((domain) => domain.value === route.domain);
		if (!domain) {
			res.writeHead(404).end(`Unknown domain ${route.domain}`);
			return;
		}
		if (!tileRoute) {
			await tileJson(req, res, route, search);
			return;
		}
		try {
			const tile = await getTile(tileRoute, domain, pathname + search, search);
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
