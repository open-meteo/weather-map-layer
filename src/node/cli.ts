/**
 * `weather-map-tiles`: the tile server as a command, configured through the
 * environment. `PORT` (8080), `DATA_URL`, `MAX_VARIABLES`, `TILE_CACHE_SIZE`
 * and `LATEST_MAX_AGE` map onto `createTileHandler`'s options.
 */
import { createServer } from 'node:http';

import { omProtocol } from './index';
import { createTileHandler } from './tile-server';

const env = process.env;
const number = (value: string | undefined): number | undefined =>
	value === undefined ? undefined : Number(value);

const port = number(env['PORT']) ?? 8080;
const handler = createTileHandler({
	protocol: omProtocol,
	dataUrl: env['DATA_URL'],
	maxVariables: number(env['MAX_VARIABLES']),
	cacheSize: number(env['TILE_CACHE_SIZE']),
	latestMaxAge: number(env['LATEST_MAX_AGE'])
});

createServer((req, res) => void handler(req, res)).listen(port, () => {
	console.log(
		`Tile server on http://localhost:${port}/tiles/{domain}/{run}/{time}/{variable}/{z}/{x}/{y}.png`
	);
});
