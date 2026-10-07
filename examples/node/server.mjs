// Tile server: renders om:// tiles on the Node entry's worker threads and
// serves them as PNG (raster) or PBF (vector). The client picks the data per
// request through the path, and the render options through the query, which
// goes to the protocol untouched:
//
//   /tiles/{domain}/{run}/{time}/{variable}/{z}/{x}/{y}.png?colorscale=…&interpolation=…
//   /tiles/{domain}/{run}/{time}/{variable}/{z}/{x}/{y}.pbf?arrows=true&contours=true&intervals=2
//
// `run` is `latest` with `time` a protocol time step (`current_time_1H`,
// `current_time_-2H`, `valid_times_3`, …), or a model run like
// `2026-10-07T0600Z` with `time` the valid time `2026-10-07T1200`. Tiles of a model run never change, so they are
// cached in memory and marked immutable for browsers and CDNs; `latest` tiles
// are cached for a minute, as long as the protocol caches `latest.json`.
//
// Run `npm run build` first, then `node examples/node/server.mjs` and open
// http://localhost:8080/tiles/dwd_icon/latest/current_time_1H/temperature_2m/2/2/1.png
// or `tileserver.html` next to this file (served with `npm run serve`).
import {
	defaultOmProtocolSettings,
	domainOptions,
	encodePng,
	omProtocol
} from '../../dist/node.mjs';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const DATA_URL = process.env.DATA_URL ?? 'https://openmeteo.s3.amazonaws.com/data_spatial';
/** Rendered tiles kept in memory. */
const TILE_CACHE_SIZE = Number(process.env.TILE_CACHE_SIZE ?? 1000);
const LATEST_MAX_AGE = 60;

const settings = {
	...defaultOmProtocolSettings,
	// Each variable of each file keeps its data loaded in one state; the
	// protocol's default of 2 suits a map, not a server answering for many
	maxStatesWithData: Number(process.env.MAX_VARIABLES ?? 8)
};

const TILE_PATH =
	/^\/tiles\/(?<domain>[\w-]+)\/(?<run>latest|\d{4}-\d{2}-\d{2}T\d{4}Z)\/(?<time>[\w+-]+)\/(?<variable>[\w-]+)\/(?<z>\d+)\/(?<x>\d+)\/(?<y>\d+)\.(?<format>png|pbf)$/;

/** The protocol URL for a route: the metadata file for `latest`, the model run's file otherwise. */
const omUrl = ({ domain, run, time, variable }, query) => {
	// The tile coordinates follow the last query parameter, and the protocol
	// drops `time_step` once resolved, so that one must not be last
	const params = new URLSearchParams(run === 'latest' ? { time_step: time } : {});
	params.set('variable', variable);
	for (const [key, value] of new URLSearchParams(query)) {
		if (key !== 'time_step' && key !== 'variable') params.set(key, value);
	}
	if (run === 'latest') {
		return `${DATA_URL}/${domain}/latest.json?${params}`;
	}
	const [date, hour] = run.split('T');
	return `${DATA_URL}/${domain}/${date.replaceAll('-', '/')}/${hour}/${time}.om?${params}`;
};

// Rendered responses by request URL, least recently used first, and the
// renders under way so a burst of identical requests renders once.
const cache = new Map();
const inflight = new Map();

const render = async (route, url) => {
	const type = route.format === 'png' ? 'image' : 'arrayBuffer';
	const { data } = await omProtocol({ url, type }, new AbortController(), settings);
	// Nothing to draw: the tile lies outside the domain
	if (data instanceof ArrayBuffer && route.format === 'png') return { status: 204 };
	const body = route.format === 'png' ? encodePng(data) : new Uint8Array(data);
	return {
		status: 200,
		body,
		contentType: route.format === 'png' ? 'image/png' : 'application/x-protobuf'
	};
};

const getTile = (route, requestUrl, url) => {
	const cached = cache.get(requestUrl);
	if (cached && cached.expires > Date.now()) {
		cache.delete(requestUrl);
		cache.set(requestUrl, cached);
		return Promise.resolve(cached);
	}
	let pending = inflight.get(requestUrl);
	if (!pending) {
		pending = render(route, url)
			.then((tile) => {
				tile.expires = route.run === 'latest' ? Date.now() + LATEST_MAX_AGE * 1000 : Infinity;
				cache.set(requestUrl, tile);
				if (cache.size > TILE_CACHE_SIZE) cache.delete(cache.keys().next().value);
				return tile;
			})
			.finally(() => inflight.delete(requestUrl));
		inflight.set(requestUrl, pending);
	}
	return pending;
};

const server = createServer(async (req, res) => {
	// Map pages on other origins (a Cesium or MapLibre app) fetch the tiles cross-origin
	res.setHeader('access-control-allow-origin', '*');
	const { pathname, search } = new URL(req.url ?? '/', 'http://localhost');
	const route = TILE_PATH.exec(pathname)?.groups;
	if (!route) {
		res.writeHead(404).end('Use /tiles/{domain}/{run}/{time}/{variable}/{z}/{x}/{y}.png or .pbf');
		return;
	}
	if (!domainOptions.some((domain) => domain.value === route.domain)) {
		res.writeHead(404).end(`Unknown domain ${route.domain}`);
		return;
	}
	const url = `om://${omUrl(route, search)}/${route.z}/${route.x}/${route.y}`;
	try {
		const tile = await getTile(route, pathname + search, url);
		res.setHeader(
			'cache-control',
			route.run === 'latest'
				? `public, max-age=${LATEST_MAX_AGE}`
				: 'public, max-age=31536000, immutable'
		);
		if (tile.status === 204) {
			res.writeHead(204).end();
			return;
		}
		res.writeHead(200, { 'content-type': tile.contentType, 'content-length': tile.body.length });
		res.end(tile.body);
	} catch (error) {
		console.error(`${req.url}:`, error);
		res.writeHead(500).end(String(error));
	}
});

server.listen(PORT, () => {
	console.log(
		`Tile server on http://localhost:${PORT}/tiles/{domain}/{run}/{time}/{variable}/{z}/{x}/{y}.png`
	);
});
