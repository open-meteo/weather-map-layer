/**
 * `weather-map-tiles`: the tile server as a command, configured through the
 * environment. `PORT` (8080), `DATA_URL`, `MAX_VARIABLES`, `TILE_CACHE_SIZE`,
 * `LATEST_MAX_AGE` and `MAX_PENDING` map onto `createTileHandler`'s options;
 * a malformed number ends the start instead of silently disabling a limit.
 */
import { createServer } from 'node:http';

import { omProtocol } from './index';
import { createTileHandler, numberOption } from './tile-server';

const env = process.env;

const port = numberOption('PORT', env['PORT']) ?? 8080;
const handler = createTileHandler({
	protocol: omProtocol,
	dataUrl: env['DATA_URL'],
	maxVariables: numberOption('MAX_VARIABLES', env['MAX_VARIABLES']),
	cacheSize: numberOption('TILE_CACHE_SIZE', env['TILE_CACHE_SIZE']),
	latestMaxAge: numberOption('LATEST_MAX_AGE', env['LATEST_MAX_AGE']),
	maxPending: numberOption('MAX_PENDING', env['MAX_PENDING'])
});

createServer((req, res) => void handler(req, res)).listen(port, () => {
	console.log(
		`Tile server on http://localhost:${port}/tiles/{domain}/{run}/{time}/{variable}/{z}/{x}/{y}.png`
	);
});
