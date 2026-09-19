// Serves the repository for the examples (`npm run serve`) with the
// cross-origin isolation headers, so the pages get the protocol's
// SharedArrayBuffer fast path. Without them every tile request copies the
// whole variable into a worker and blocks the main thread (see README,
// "Cross-origin isolation").
//
// A launcher rather than `live-server --middleware=…`: that flag only loads
// `.js` files, which this `type: module` package would treat as ES modules.
//
// `require-corp` is what the Open-Meteo maps app uses; the CDNs the examples
// load scripts from (unpkg, jsdelivr) send the Cross-Origin-Resource-Policy it
// demands, and the data, style and tile requests are CORS fetches anyway.
const liveServer = require('live-server');

liveServer.start({
	port: 5173,
	host: 'localhost',
	root: '.',
	open: '/examples/',
	ignore: '**/src/**',
	middleware: [
		(req, res, next) => {
			res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
			res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
			next();
		}
	]
});
