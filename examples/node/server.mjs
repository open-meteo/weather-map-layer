// Minimal tile server: renders om:// tiles in-process and serves them as PNG
// (raster) or PBF (vector). Run `npm run build` first, then
//   OM_URL='https://.../latest.json?variable=temperature_2m' node examples/node/server.mjs
// and open http://localhost:8080/tiles/2/2/1.png, or `tileserver.html` next to
// this file (served with `npm run serve`) for a MapLibre map on these tiles.
import { encodePng, omProtocol } from '../../dist/node.mjs';
import { createServer } from 'node:http';

const OM_URL =
	process.env.OM_URL ??
	'https://openmeteo.s3.amazonaws.com/data_spatial/dwd_icon/latest.json?variable=temperature_2m';
const PORT = Number(process.env.PORT ?? 8080);

// `/tiles/{z}/{x}/{y}.png` for the raster tile, `.pbf` for the vector tile
// (contours, arrows, grid points, as requested by the OM_URL query).
const TILE_PATH = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.(png|pbf)$/;

const server = createServer(async (req, res) => {
	// Map pages on other origins (a Cesium or MapLibre app) fetch the tiles cross-origin
	res.setHeader('access-control-allow-origin', '*');
	const match = TILE_PATH.exec(req.url ?? '');
	if (!match) {
		res.writeHead(404).end('Use /tiles/{z}/{x}/{y}.png or .pbf');
		return;
	}
	const [, z, x, y, format] = match;
	const url = `om://${OM_URL}/${z}/${x}/${y}`;
	try {
		if (format === 'png') {
			const { data } = await omProtocol({ url, type: 'image' }, new AbortController());
			if (data instanceof ArrayBuffer) {
				// Nothing to draw: the tile lies outside the domain
				res.writeHead(204).end();
				return;
			}
			const png = encodePng(data);
			res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
			res.end(png);
		} else {
			const { data } = await omProtocol({ url, type: 'arrayBuffer' }, new AbortController());
			const pbf = new Uint8Array(data);
			res.writeHead(200, {
				'content-type': 'application/x-protobuf',
				'content-length': pbf.length
			});
			res.end(pbf);
		}
	} catch (error) {
		console.error(`${req.url}:`, error);
		res.writeHead(500).end(String(error));
	}
});

server.listen(PORT, () => {
	console.log(`Tile server on http://localhost:${PORT}/tiles/{z}/{x}/{y}.png for ${OM_URL}`);
});
