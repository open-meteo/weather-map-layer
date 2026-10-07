// The tile server embedded in your own `node:http` server: the handler
// answers everything under `/tiles/` (see `createTileHandler` for the route
// and its caching). Run `npm run build` first, then `node examples/node/server.mjs`
// and open http://localhost:8080/tiles/dwd_icon/latest/current_time_1H/temperature_2m/2/2/1.png
// or `tileserver.html` next to this file (served with `npm run serve`).
// Without a server of your own, `npx weather-map-tiles` runs the same thing.
import { createTileHandler, omProtocol } from '../../dist/node.mjs';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);

const handler = createTileHandler({ protocol: omProtocol });

createServer((req, res) => handler(req, res)).listen(PORT, () => {
	console.log(
		`Tile server on http://localhost:${PORT}/tiles/{domain}/{run}/{time}/{variable}/{z}/{x}/{y}.png`
	);
});
