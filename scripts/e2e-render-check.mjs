/**
 * End-to-end render verification for the om protocol examples.
 *
 * Serves the repo root on localhost, opens example pages in headless Chromium
 * and verifies that:
 *  - the map reaches the "all tiles loaded" state without page errors
 *  - the weather raster layer actually paints pixels (screenshot diff with the
 *    layer hidden — WebGL canvas readback is blank in headless, so we compare
 *    compositor screenshots instead)
 *  - vector layers (contours / arrows / grid points) produce rendered features
 *  - [wml-bench] benchmark lines appear on the console when enabled
 *
 * Usage: node scripts/e2e-render-check.mjs
 *
 * No repo dependencies: playwright is imported from the sibling maps project.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } =
	await import('/home/vincent/Projects/open-meteo/maps/node_modules/playwright/index.mjs');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8123;

const MIME = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.map': 'application/json'
};

const server = http.createServer(async (req, res) => {
	try {
		const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
		const filePath = path.join(repoRoot, urlPath);
		if (!filePath.startsWith(repoRoot)) throw new Error('forbidden');
		const body = await readFile(filePath);
		res.writeHead(200, {
			'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream'
		});
		res.end(body);
	} catch {
		res.writeHead(404);
		res.end('not found');
	}
});
await new Promise((resolve) => server.listen(PORT, resolve));

const SCENARIOS = [
	{
		name: 'raster temperature (TileJSON non-blocking) + benchmark logs',
		url: `/examples/temperature.html?wml-bench#4/50/10`,
		rasterLayers: ['omFileLayer'],
		expectBenchLogs: true
	},
	{
		name: 'contours on color scale breakpoints (multi-interval culling path)',
		url: `/examples/vector/contouring/contouring-on-colorscale.html#4/50/10`,
		rasterLayers: ['omFileRasterLayer'],
		vectorLayers: ['omFileVectorLayer']
	},
	{
		name: 'contours with fixed interval (single-interval path)',
		url: `/examples/vector/contouring/contouring-pressure.html#4/50/10`,
		vectorQuery: true
	},
	{
		name: 'wind arrows (u/v derivation + vector path)',
		url: `/examples/vector/wind-arrows.html#4/50/10`,
		vectorQuery: true
	},
	{
		name: 'GPU rendering prototype (custom layer)',
		url: `/examples/gpu/temperature-gpu.html#4/50/10`,
		customLayer: 'gpu-weather',
		// Skip when the GPU prototype (separate branch) isn't checked out
		skip: !existsSync(path.join(repoRoot, 'examples/gpu/gpu-layer.js'))
	},
	{
		name: 'GPU time interpolation (5-minute steps across an hour boundary)',
		url: `/examples/gpu/time-animation-gpu.html#4/50/10`,
		customLayer: 'gpu-weather',
		// 13 five-minute steps: crosses the hour boundary, exercising advance()
		animSteps: 13,
		skip: !existsSync(path.join(repoRoot, 'examples/gpu/time-animation-gpu.html'))
	}
];

// Expose the maplibre Map instance as window.__map by wrapping the constructor
// the moment the UMD bundle assigns window.maplibregl.
const exposeMapInit = `
	(() => {
		let lib;
		Object.defineProperty(window, 'maplibregl', {
			configurable: true,
			get() { return lib; },
			set(value) {
				lib = value;
				if (value && value.Map) {
					const OrigMap = value.Map;
					value.Map = class extends OrigMap {
						constructor(...args) {
							super(...args);
							window.__map = this;
						}
					};
				}
			}
		});
	})();
`;

/** Count differing pixels between two same-size PNG screenshots, in-page. */
const diffPixels = async (page, bufA, bufB) => {
	return page.evaluate(
		async ([a, b]) => {
			const load = (b64) =>
				new Promise((resolve, reject) => {
					const img = new Image();
					img.onload = () => resolve(img);
					img.onerror = reject;
					img.src = 'data:image/png;base64,' + b64;
				});
			const [imgA, imgB] = await Promise.all([load(a), load(b)]);
			const w = Math.min(imgA.width, imgB.width);
			const h = Math.min(imgA.height, imgB.height);
			const canvas = document.createElement('canvas');
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext('2d', { willReadFrequently: true });
			ctx.drawImage(imgA, 0, 0);
			const dataA = ctx.getImageData(0, 0, w, h).data;
			ctx.clearRect(0, 0, w, h);
			ctx.drawImage(imgB, 0, 0);
			const dataB = ctx.getImageData(0, 0, w, h).data;
			let diff = 0;
			for (let i = 0; i < dataA.length; i += 4) {
				if (
					Math.abs(dataA[i] - dataB[i]) > 8 ||
					Math.abs(dataA[i + 1] - dataB[i + 1]) > 8 ||
					Math.abs(dataA[i + 2] - dataB[i + 2]) > 8
				) {
					diff++;
				}
			}
			return { diff, total: w * h };
		},
		[bufA.toString('base64'), bufB.toString('base64')]
	);
};

const waitForTiles = async (page) => {
	await page.waitForFunction(() => window.__map && window.__map.loaded(), null, {
		timeout: 60_000
	});
	// areTilesLoaded flickers while sources stream in; require it to hold stable.
	await page.waitForFunction(
		() =>
			new Promise((resolve) => {
				const map = window.__map;
				if (!map.areTilesLoaded()) return resolve(false);
				setTimeout(() => resolve(map.areTilesLoaded() && map.loaded()), 400);
			}),
		null,
		{ timeout: 90_000, polling: 500 }
	);
	await page.waitForTimeout(750);
};

const browser = await chromium.launch();
let failures = 0;

for (const scenario of SCENARIOS) {
	if (scenario.skip) {
		console.log(`\n${scenario.name}\n  - skipped (files not present on this branch)`);
		continue;
	}
	const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
	const consoleErrors = [];
	const benchLogs = [];
	page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
	page.on('console', (msg) => {
		const text = msg.text();
		if (text.includes('[wml-bench]')) benchLogs.push(text);
		else if (msg.type() === 'error') consoleErrors.push(text);
	});
	await page.addInitScript(exposeMapInit);

	const results = [];
	const fail = (msg) => {
		failures++;
		results.push(`  ✗ ${msg}`);
	};
	const ok = (msg) => results.push(`  ✓ ${msg}`);

	try {
		await page.goto(`http://localhost:${PORT}${scenario.url}`, { waitUntil: 'load' });
		await waitForTiles(page);
		if (scenario.customLayer) {
			await page.waitForFunction(
				(id) => window.__map.getLayer(id) !== undefined,
				scenario.customLayer,
				{ timeout: 60_000 }
			);
			await page.waitForTimeout(1000);
		}
		ok('map loaded, all tiles loaded');

		// Time interpolation check: step the animation forward and require the
		// rendered pixels to change (a frozen u_mix would leave them identical).
		if (scenario.animSteps) {
			await page.waitForFunction(() => window.__anim !== undefined, null, { timeout: 60_000 });
			const shotBefore = await page.screenshot();
			const stepped = await page.evaluate(async (n) => {
				let count = 0;
				for (let i = 0; i < n; i++) {
					if (await window.__anim.stepForward()) count++;
				}
				return count;
			}, scenario.animSteps);
			await page.waitForTimeout(500);
			const shotAfter = await page.screenshot();
			const anim = await diffPixels(page, shotBefore, shotAfter);
			if (stepped === scenario.animSteps && anim.diff > 0) {
				ok(
					`${stepped} five-minute steps incl. hour advance, ` +
						`${((100 * anim.diff) / anim.total).toFixed(1)}% of pixels changed`
				);
			} else {
				fail(`animation: ${stepped}/${scenario.animSteps} steps, ${anim.diff} pixels changed`);
			}

			// Scrubber: jump 3 hours ahead (forces loads) and verify the time
			// label follows and pixels change again.
			const scrubbed = await page.evaluate(async () => {
				const before = document.getElementById('time').textContent;
				const target = Number(document.getElementById('scrub').value) + 3 * 12;
				await window.__anim.applyPosition(target);
				return { before, after: document.getElementById('time').textContent };
			});
			await page.waitForTimeout(500);
			const shotScrubbed = await page.screenshot();
			const scrubDiff = await diffPixels(page, shotAfter, shotScrubbed);
			if (scrubbed.before !== scrubbed.after && scrubDiff.diff > 0) {
				ok(
					`scrubber jump ${scrubbed.before} → ${scrubbed.after}, ` +
						`${((100 * scrubDiff.diff) / scrubDiff.total).toFixed(1)}% of pixels changed`
				);
			} else {
				fail(`scrubber jump did not change the view (${JSON.stringify(scrubbed)})`);
			}
		}

		// Vector feature check: any rendered features from om vector source layers
		if (scenario.vectorLayers || scenario.vectorQuery) {
			const featureCount = await page.evaluate(() => {
				const map = window.__map;
				const style = map.getStyle();
				const omVectorLayerIds = (style.layers ?? [])
					.filter((l) => l['source-layer'])
					.map((l) => l.id);
				const features = map.queryRenderedFeatures({ layers: omVectorLayerIds });
				return features.length;
			});
			if (featureCount > 0) ok(`vector layers rendered ${featureCount} features`);
			else fail('no vector features rendered');
		}

		// Raster paint check: hide om layers, compare screenshots.
		// Custom layers ignore the visibility layout property — zero their
		// opacity through the layer instance instead.
		const shotWith = await page.screenshot();
		const hidden = await page.evaluate((customLayer) => {
			const map = window.__map;
			const ids = (map.getStyle().layers ?? [])
				.filter((l) => l.source && String(l.source).startsWith('omFile'))
				.map((l) => l.id);
			for (const id of ids) map.setLayoutProperty(id, 'visibility', 'none');
			if (customLayer && window.__gpuLayer) {
				window.__gpuLayer.setOpacity(0);
				ids.push(customLayer);
			}
			return ids;
		}, scenario.customLayer ?? null);
		await page.waitForTimeout(1000);
		const shotWithout = await page.screenshot();
		const { diff, total } = await diffPixels(page, shotWith, shotWithout);
		const pct = ((100 * diff) / total).toFixed(1);
		if (diff > total * 0.02) ok(`om layers paint ${pct}% of viewport (${hidden.join(', ')})`);
		else fail(`om layers changed only ${pct}% of pixels — layer appears empty`);

		if (scenario.expectBenchLogs) {
			if (benchLogs.length > 0) {
				ok(`benchmark logging active (${benchLogs.length} lines)`);
				console.log('    sample:', benchLogs[Math.floor(benchLogs.length / 2)]);
			} else fail('no [wml-bench] console lines seen');
		}

		const realErrors = consoleErrors.filter(
			// Base-map style resources (planet tiles/sprites/glyphs) reject the
			// localhost origin via CORS — unrelated to the om protocol under test.
			(e) => !/sprite|glyph|favicon|tiles\.open-meteo\.com|ERR_FAILED|AJAXError/i.test(e)
		);
		if (realErrors.length === 0) ok('no console/page errors');
		else fail(`console errors:\n      ${realErrors.slice(0, 5).join('\n      ')}`);
	} catch (err) {
		fail(`scenario crashed: ${err.message.split('\n')[0]}`);
	}

	console.log(`\n${scenario.name}`);
	for (const line of results) console.log(line);
	await page.close();
}

await browser.close();
server.close();

console.log(failures === 0 ? '\nAll scenarios passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
