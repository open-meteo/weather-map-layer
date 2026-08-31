/**
 * Headless GPU-path verification: compiles and renders every shader variant in
 * a real (SwiftShader) WebGL2 context and pixel-compares the GPU tile output
 * against the CPU reference (GridFactory.getInterpolatedValue + getColor — the
 * exact math the CPU worker uses), on synthetic data with NaN holes.
 *
 * Usage: node scripts/verify-gpu.mjs   (requires `npm run build:umd` first)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, '..', 'dist', 'index.js');

// The UMD bundle's import.meta.url polyfill needs a real document URL and a
// script src, so serve a minimal page from disk instead of about:blank.
const pageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wml-gpu-verify-'));
const pagePath = path.join(pageDir, 'index.html');
fs.writeFileSync(
	pagePath,
	`<!doctype html><html><head><meta charset="utf-8" /><script src="${pathToFileURL(distPath)}"></script></head><body></body></html>`
);

const browser = await chromium.launch({
	headless: true,
	args: [
		'--no-sandbox',
		'--use-angle=swiftshader',
		'--enable-unsafe-swiftshader',
		'--allow-file-access-from-files'
	]
});
const page = await browser.newPage();
page.on('console', (message) => {
	if (message.type() === 'error' || message.type() === 'warning') {
		console.log(`[page ${message.type()}]`, message.text());
	}
});
page.on('pageerror', (error) => console.log('[pageerror]', error.message));
await page.goto(pathToFileURL(pagePath).href);

const results = await page.evaluate(async () => {
	const OM = globalThis.OMWeatherMapLayer;
	const TILE = 64;

	const tile2lon = (x, z) => (((x / Math.pow(2, z)) * 360 + 360) % 360) - 180;
	const tile2lat = (y, z) => {
		const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
		return (Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) * 180) / Math.PI;
	};

	const colorScale = {
		type: 'breakpoint',
		unit: 't',
		breakpoints: [0, 25, 50, 75, 100],
		colors: [
			[0, 0, 255, 1],
			[0, 255, 255, 1],
			[0, 255, 0, 1],
			[255, 255, 0, 1],
			[255, 0, 0, 1]
		]
	};

	// Synthetic field: smooth ramp with a NaN hole
	const makeValues = (nx, ny) => {
		const values = new Float32Array(nx * ny);
		for (let j = 0; j < ny; j++) {
			for (let i = 0; i < nx; i++) {
				values[j * nx + i] =
					50 + 40 * Math.sin((i / nx) * Math.PI * 2) * Math.cos((j / ny) * Math.PI);
			}
		}
		// NaN hole to exercise the NaN-aware interpolation branches (flat index
		// range for 1-row layouts, i.e. the reduced gaussian grid)
		if (ny === 1) {
			for (let i = Math.floor(nx * 0.4); i < Math.floor(nx * 0.42); i++) {
				values[i] = NaN;
			}
		} else {
			for (let j = Math.floor(ny * 0.4); j < Math.floor(ny * 0.5); j++) {
				for (let i = Math.floor(nx * 0.4); i < Math.floor(nx * 0.5); i++) {
					values[j * nx + i] = NaN;
				}
			}
		}
		return values;
	};

	const grids = [
		{
			name: 'regular (regional)',
			grid: { type: 'regular', nx: 60, ny: 40, lonMin: 0, latMin: 20, dx: 0.5, dy: 0.5 }
		},
		{
			name: 'regular (global, ICON-style wrap)',
			tile: { z: 0, x: 0, y: 0 },
			grid: { type: 'regular', nx: 287, ny: 144, lonMin: -180, latMin: -90, dx: 1.2544, dy: 1.25 }
		},
		{
			name: 'projected LCC',
			grid: {
				type: 'projectedFromBounds',
				nx: 180,
				ny: 106,
				latitude: [21.138, 47.8424],
				longitude: [-122.72, -60.918],
				projection: {
					λ0: -97.5,
					ϕ0: 0,
					ϕ1: 38.5,
					ϕ2: 38.5,
					name: 'LambertConformalConicProjection'
				}
			}
		},
		{
			name: 'projected rotated lat/lon',
			grid: {
				type: 'projectedFromGeographicOrigin',
				nx: 100,
				ny: 80,
				latitude: 40,
				longitude: 0,
				dx: 0.25,
				dy: 0.25,
				projection: { rotatedLat: -35, rotatedLon: -8, name: 'RotatedLatLonProjection' }
			}
		},
		{
			name: 'projected stereographic',
			grid: {
				type: 'projectedFromGeographicOrigin',
				nx: 100,
				ny: 100,
				latitude: 55,
				longitude: -60,
				dx: 25000,
				dy: 25000,
				projection: { latitude: 90, longitude: -100, name: 'StereographicProjection' }
			}
		},
		{
			name: 'gaussian (reduced, global)',
			tile: { z: 1, x: 1, y: 0 },
			// Small O48-style reduced gaussian grid; nx = total point count
			grid: { type: 'gaussian', nx: 4 * 48 * (48 + 9), ny: 1, gaussianGridLatitudeLines: 48 }
		},
		{
			name: 'projected LAEA',
			grid: {
				type: 'projectedFromGeographicOrigin',
				nx: 120,
				ny: 100,
				latitude: 42,
				longitude: -2,
				dx: 20000,
				dy: 20000,
				projection: { λ0: 10, ϕ1: 52, radius: 6371229, name: 'LambertAzimuthalEqualAreaProjection' }
			}
		}
	];

	const renderer = new OM.GpuTileRenderer();
	const out = [];

	// Derive a tile that actually covers the grid: centre of the grid bounds at
	// a zoom where the grid spans roughly one tile.
	const deriveTile = (grid) => {
		const bounds = OM.GridFactory.create(grid, null).getBounds();
		const [west, south, east, north] = bounds;
		const lonSpan = Math.max(east - west, 1e-6);
		const z = Math.max(0, Math.min(6, Math.round(Math.log2(360 / lonSpan))));
		const centerLon = (west + east) / 2;
		const centerLat = Math.max(-80, Math.min(80, (south + north) / 2));
		const n = Math.pow(2, z);
		const x = Math.max(0, Math.min(n - 1, Math.floor(lon2tileX(centerLon, z))));
		const y = Math.max(0, Math.min(n - 1, Math.floor(lat2tileY(centerLat, z))));
		return { z, x, y };
	};
	const lon2tileX = (lon, z) => Math.pow(2, z) * ((lon + 180) / 360);
	const lat2tileY = (lat, z) => {
		const rad = (lat * Math.PI) / 180;
		return (Math.pow(2, z) * (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI)) / 2;
	};

	for (const { name, grid, tile: fixedTile } of grids) {
		const tile = fixedTile ?? deriveTile(grid);
		for (const interpolation of ['nearest', 'linear', 'cubic', 'monotone']) {
			for (const colorBlend of [false, true]) {
				const values = makeValues(grid.nx, grid.ny);
				const ranges = [
					{ start: 0, end: grid.ny },
					{ start: 0, end: grid.nx }
				];
				const scaleFactor = 20;
				const domain = { value: 'test', grid, time_interval: 'hourly', model_interval: 'hourly' };

				let bitmap;
				try {
					bitmap = renderer.renderTile({
						tileIndex: tile,
						data: { values, directions: undefined, scaleFactor },
						ranges,
						domain,
						renderOptions: {
							tileSize: TILE,
							interpolation,
							colorBlend,
							colorScale,
							drawGrid: false,
							drawArrows: false,
							arrowStyle: 'arrow',
							arrowRender: 'line',
							arrowPoints: 25,
							drawContours: false,
							intervals: [2]
						}
					});
				} catch (error) {
					out.push({ name, interpolation, colorBlend, error: String(error) });
					continue;
				}

				// Read GPU pixels back
				const canvas = document.createElement('canvas');
				canvas.width = TILE;
				canvas.height = TILE;
				const context = canvas.getContext('2d', { willReadFrequently: true });
				context.drawImage(bitmap, 0, 0);
				const gpu = context.getImageData(0, 0, TILE, TILE).data;

				// CPU reference: the same per-pixel math the CPU worker runs
				const cpuGrid = OM.GridFactory.create(grid, ranges);
				const halfQuantum = 0.5 / scaleFactor;
				let painted = 0;
				let compared = 0;
				let maxDiff = 0;
				let badPixels = 0;
				for (let row = 0; row < TILE; row++) {
					const lat = tile2lat(tile.y + (row + 0.5) / TILE, tile.z);
					for (let col = 0; col < TILE; col++) {
						const lon = tile2lon(tile.x + (col + 0.5) / TILE, tile.z);
						const value = cpuGrid.getInterpolatedValue(values, lat, lon, interpolation);
						const i = 4 * (row * TILE + col);
						const alpha = gpu[i + 3];
						if (alpha > 0) painted++;
						if (!isFinite(value)) continue;
						// Skip pixels in the outermost edge zone of the grid: fp32 vs fp64
						// projection rounding legitimately disagrees about membership there.
						const latStep = Math.abs(tile2lat(tile.y + (row + 1.5) / TILE, tile.z) - lat);
						const lonStep = Math.abs(tile2lon(tile.x + (col + 1.5) / TILE, tile.z) - lon);
						let nearEdge = false;
						for (const [dLat, dLon] of [
							[-latStep, -lonStep],
							[-latStep, lonStep],
							[latStep, -lonStep],
							[latStep, lonStep]
						]) {
							if (
								!isFinite(
									cpuGrid.getInterpolatedValue(values, lat + dLat, lon + dLon, interpolation)
								)
							) {
								nearEdge = true;
								break;
							}
						}
						if (nearEdge) continue;
						// Nearest-neighbour flips its cell decision exactly on the half-cell
						// boundary; fp32 legitimately lands on the other side of it. Skip
						// pixels whose decision is not stable within a small sub-pixel move.
						if (interpolation === 'nearest') {
							let unstable = false;
							for (const [dLat, dLon] of [
								[-latStep * 0.15, -lonStep * 0.15],
								[-latStep * 0.15, lonStep * 0.15],
								[latStep * 0.15, -lonStep * 0.15],
								[latStep * 0.15, lonStep * 0.15]
							]) {
								const neighbor = cpuGrid.getInterpolatedValue(
									values,
									lat + dLat,
									lon + dLon,
									'nearest'
								);
								if (!isFinite(neighbor) || Math.abs(neighbor - value) > 1e-6) {
									unstable = true;
									break;
								}
							}
							if (unstable) continue;
						}
						const expected = OM.getColor(colorScale, value + halfQuantum, colorBlend);
						// Skip pixels within one quantisation step of a breakpoint: LUT
						// discretisation and fp32 rounding legitimately flip the band there.
						const nearBreakpoint = colorScale.breakpoints.some(
							(b) => Math.abs(value + halfQuantum - b) < 0.3
						);
						if (nearBreakpoint) continue;
						compared++;
						let diff = Math.abs(alpha - Math.round(255 * expected[3]));
						for (let ch = 0; ch < 3; ch++) {
							diff = Math.max(diff, Math.abs(gpu[i + ch] - expected[ch]));
						}
						maxDiff = Math.max(maxDiff, diff);
						if (diff > 6) badPixels++;
					}
				}

				out.push({ name, tile, interpolation, colorBlend, painted, compared, maxDiff, badPixels });
			}
		}
	}

	// ─── Seamless multi-layer blending ─────────────────────────────────────────
	// Drawn through WeatherGpuRenderer directly (multi-layer draw), compared
	// against the exact CPU blend (sampleBlendedValue) the worker uses.
	{
		const canvas = new OffscreenCanvas(TILE, TILE);
		const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true });
		const seamlessRenderer = new OM.WeatherGpuRenderer(gl);

		const lccGrid = {
			type: 'projectedFromBounds',
			nx: 180,
			ny: 106,
			latitude: [21.138, 47.8424],
			longitude: [-122.72, -60.918],
			projection: {
				λ0: -97.5,
				ϕ0: 0,
				ϕ1: 38.5,
				ϕ2: 38.5,
				name: 'LambertConformalConicProjection'
			}
		};
		const cases = [
			{
				name: 'seamless regular-over-regular',
				layers: [
					{
						grid: { type: 'regular', nx: 200, ny: 120, lonMin: 0, latMin: 30, dx: 0.2, dy: 0.2 },
						blendWidthDeg: 4
					},
					{
						grid: { type: 'regular', nx: 360, ny: 181, lonMin: -180, latMin: -90, dx: 1, dy: 1 },
						blendWidthDeg: 0
					}
				]
			},
			{
				name: 'seamless LCC-over-gaussian',
				layers: [
					{ grid: lccGrid, blendWidthDeg: 3 },
					{
						grid: { type: 'gaussian', nx: 4 * 48 * (48 + 9), ny: 1, gaussianGridLatitudeLines: 48 },
						blendWidthDeg: 0
					}
				]
			}
		];

		for (const { name, layers } of cases) {
			// Tile over the finest layer's western edge so the blend zone is on-screen
			const finestBounds = OM.GridFactory.create(layers[0].grid, null).getBounds();
			const z = Math.max(
				1,
				Math.min(6, Math.round(Math.log2(360 / Math.max(finestBounds[2] - finestBounds[0], 1e-6))))
			);
			const n = Math.pow(2, z);
			const edgeLat = Math.max(-80, Math.min(80, (finestBounds[1] + finestBounds[3]) / 2));
			const tile = {
				z,
				x: Math.max(0, Math.min(n - 1, Math.floor(lon2tileX(finestBounds[0], z)))),
				y: Math.max(0, Math.min(n - 1, Math.floor(lat2tileY(edgeLat, z))))
			};

			for (const interpolation of ['nearest', 'linear', 'cubic', 'monotone']) {
				const fullRangesOf = (grid) => [
					{ start: 0, end: grid.ny },
					{ start: 0, end: grid.nx }
				];
				const layerValues = layers.map((l) => makeValues(l.grid.nx, l.grid.ny));
				const layerGrids = layers.map((l) => OM.GridFactory.create(l.grid, fullRangesOf(l.grid)));
				const fullGrids = layers.map((l) => OM.GridFactory.create(l.grid, null));

				// GPU: one multi-layer draw into the tile's mercator box
				gl.viewport(0, 0, TILE, TILE);
				gl.disable(gl.BLEND);
				gl.clearColor(0, 0, 0, 0);
				gl.clear(gl.COLOR_BUFFER_BIT);
				const worldTiles = Math.pow(2, tile.z);
				const drawLayers = layers.map((l, i) => {
					const gridUniforms = OM.computeGridUniforms(l.grid, null);
					return {
						gridUniforms,
						valuesTexture: seamlessRenderer.getValueTexture(
							layerValues[i],
							gridUniforms.nx,
							gridUniforms.ny
						),
						blendWidthDeg: l.blendWidthDeg
					};
				});
				let renderError;
				try {
					seamlessRenderer.draw({
						matrix: OM.mercatorBoxMatrix(
							tile.x / worldTiles,
							tile.y / worldTiles,
							(tile.x + 1) / worldTiles,
							(tile.y + 1) / worldTiles
						),
						layers: drawLayers,
						interpolation,
						lut: seamlessRenderer.getLut(colorScale, true),
						halfQuantum: 0.025,
						opacity: 1,
						quad: [
							tile.x / worldTiles,
							tile.y / worldTiles,
							(tile.x + 1) / worldTiles,
							(tile.y + 1) / worldTiles
						]
					});
				} catch (error) {
					renderError = String(error);
				}
				if (renderError) {
					out.push({ name, tile, interpolation, colorBlend: true, error: renderError });
					continue;
				}
				const gpu = new Uint8Array(TILE * TILE * 4);
				gl.readPixels(0, 0, TILE, TILE, gl.RGBA, gl.UNSIGNED_BYTE, gpu);

				// CPU: the exact blend the worker uses
				const seamlessLayers = layers.map((l, i) => ({
					domain: {
						value: `t${i}`,
						grid: l.grid,
						time_interval: 'hourly',
						model_interval: 'hourly'
					},
					data: { values: layerValues[i] },
					ranges: fullRangesOf(l.grid),
					domainBounds: fullGrids[i].getBounds(),
					blendWidthDeg: l.blendWidthDeg
				}));
				const sampler = OM.sampleBlendedValue(layerGrids, seamlessLayers, fullGrids, interpolation);

				let painted = 0;
				let compared = 0;
				let maxDiff = 0;
				let badPixels = 0;
				for (let row = 0; row < TILE; row++) {
					const lat = tile2lat(tile.y + (row + 0.5) / TILE, tile.z);
					const latStep = Math.abs(tile2lat(tile.y + (row + 1.5) / TILE, tile.z) - lat);
					for (let col = 0; col < TILE; col++) {
						const lon = tile2lon(tile.x + (col + 0.5) / TILE, tile.z);
						const lonStep = Math.abs(tile2lon(tile.x + (col + 1.5) / TILE, tile.z) - lon);
						// readPixels rows are bottom-up
						const i = 4 * ((TILE - 1 - row) * TILE + col);
						if (gpu[i + 3] > 0) painted++;

						const value = sampler(lat, lon);
						if (!isFinite(value)) continue;
						// Skip decision-boundary zones (grid edges, NaN holes, nearest cell
						// flips): fp32 legitimately lands on the other side of them.
						let skip = false;
						for (const [dLat, dLon] of [
							[-latStep, -lonStep],
							[-latStep, lonStep],
							[latStep, -lonStep],
							[latStep, lonStep]
						]) {
							const neighbor = sampler(lat + dLat * 0.5, lon + dLon * 0.5);
							if (
								!isFinite(neighbor) ||
								(interpolation === 'nearest' && Math.abs(neighbor - value) > 1e-6)
							) {
								skip = true;
								break;
							}
						}
						if (skip) continue;

						const expected = OM.getColor(colorScale, value + 0.025, true);
						compared++;
						let diff = Math.abs(gpu[i + 3] - Math.round(255 * expected[3]));
						for (let ch = 0; ch < 3; ch++) {
							diff = Math.max(diff, Math.abs(gpu[i + ch] - expected[ch]));
						}
						maxDiff = Math.max(maxDiff, diff);
						if (diff > 6) badPixels++;
					}
				}
				out.push({
					name,
					tile,
					interpolation,
					colorBlend: true,
					painted,
					compared,
					maxDiff,
					badPixels
				});
			}
		}
	}

	return out;
});

await browser.close();

let failures = 0;
for (const r of results) {
	const label = `${r.name} / ${r.interpolation} / blend=${r.colorBlend}`;
	if (r.error) {
		failures++;
		console.log(`FAIL ${label}: ${r.error}`);
	} else if (r.painted === 0) {
		failures++;
		console.log(`FAIL ${label}: no pixels painted`);
	} else if (r.compared > 0 && r.badPixels / r.compared > 0.01) {
		failures++;
		console.log(
			`FAIL ${label}: ${r.badPixels}/${r.compared} pixels differ (>6/255), maxDiff=${r.maxDiff}`
		);
	} else {
		console.log(
			`ok   ${label}: painted=${r.painted} compared=${r.compared} maxDiff=${r.maxDiff} bad=${r.badPixels}`
		);
	}
}

console.log(failures === 0 ? '\nAll GPU shader variants verified.' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
