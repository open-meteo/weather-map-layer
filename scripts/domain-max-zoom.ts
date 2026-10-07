/**
 * Finds, per domain, the zoom level beyond which rendered tiles stop changing
 * in any visible way, so a tile server can cap `maxzoom` per domain and let
 * clients overzoom instead of rendering ever finer tiles of the same data.
 *
 * Two numbers per domain:
 *
 * - The resolution zoom: the first zoom at which a pixel of a 512 px Web
 *   Mercator tile is finer than the grid spacing at the domain's centre. Past
 *   it, tiles only interpolate between the same grid points.
 * - The measured zoom: tiles at the domain's centre are rendered for every
 *   zoom, and each one is compared with its parent tile upsampled 2x
 *   (bilinear, as a map client overzooms). The measured zoom is the first zoom
 *   from which on the fraction of visibly different pixels stays under the
 *   threshold.
 *
 *   NODE_USE_ENV_PROXY=1 node --import tsx scripts/domain-max-zoom.ts [domain …]
 */
import { isSeamlessDomain } from '../src/domain-helpers';
import { domainOptions } from '../src/domains';
import { GridFactory } from '../src/grids';
import { gridResolutionZoom, gridSpacing } from '../src/grids/max-zoom';
import { MainThreadRenderer } from '../src/node/main-thread-renderer';
import { createOmProtocol, defaultOmProtocolSettings } from '../src/om-protocol-core';
import { updateCurrentBounds } from '../src/utils/bounds';
import { lat2tile, lon2tile, tile2lat, tile2lon } from '../src/utils/math';

import type { Domain, RgbaTile } from '../src/types';

const DATA_URL = 'https://openmeteo.s3.amazonaws.com/data_spatial';
const TILE_SIZE = 512;
const MAX_ZOOM = 12;
/** A pixel counts as visibly different above this change in any channel (of 255). */
const VISIBLE_DIFF = 32;
/** A pixel counts as changed at all above this change in any channel (of 255). */
const SLIGHT_DIFF = 8;
/** Fraction of visibly different pixels under which two zooms count as the same. */
const SAME_FRACTION = 0.01;

const omProtocol = createOmProtocol(new MainThreadRenderer());
const settings = { ...defaultOmProtocolSettings, maxStatesWithData: 1 };

const renderTile = async (omUrl: string, z: number, x: number, y: number): Promise<RgbaTile> => {
	const { data } = await omProtocol(
		{ url: `om://${omUrl}/${z}/${x}/${y}`, type: 'image' },
		new AbortController(),
		settings
	);
	if (data instanceof ArrayBuffer) throw new Error('empty tile');
	return data as RgbaTile;
};

interface Difference {
	/** Fraction of pixels differing by more than `VISIBLE_DIFF`. */
	visible: number;
	/** Fraction of pixels differing by more than `SLIGHT_DIFF`. */
	slight: number;
	/** Mean of the largest channel difference per pixel. */
	mean: number;
}

/**
 * How the child tile differs from the parent tile's quadrant upsampled 2x
 * bilinearly, over the pixels opaque in both.
 */
const difference = (parent: RgbaTile, child: RgbaTile, qx: number, qy: number): Difference => {
	const n = TILE_SIZE;
	const p = parent.rgba;
	const c = child.rgba;
	let compared = 0;
	let visible = 0;
	let slight = 0;
	let total = 0;
	for (let v = 0; v < n; v++) {
		const sy = qy * (n / 2) + (v + 0.5) / 2 - 0.5;
		const y0 = Math.max(0, Math.min(n - 1, Math.floor(sy)));
		const y1 = Math.min(n - 1, y0 + 1);
		const fy = Math.max(0, sy - y0);
		for (let u = 0; u < n; u++) {
			const sx = qx * (n / 2) + (u + 0.5) / 2 - 0.5;
			const x0 = Math.max(0, Math.min(n - 1, Math.floor(sx)));
			const x1 = Math.min(n - 1, x0 + 1);
			const fx = Math.max(0, sx - x0);
			const ci = (v * n + u) * 4;
			if (c[ci + 3] === 0) continue;
			let maxDiff = 0;
			let opaque = true;
			for (let k = 0; k < 4; k++) {
				const i00 = (y0 * n + x0) * 4 + k;
				const i01 = (y0 * n + x1) * 4 + k;
				const i10 = (y1 * n + x0) * 4 + k;
				const i11 = (y1 * n + x1) * 4 + k;
				const value =
					(p[i00] * (1 - fx) + p[i01] * fx) * (1 - fy) + (p[i10] * (1 - fx) + p[i11] * fx) * fy;
				if (k === 3 && value === 0) opaque = false;
				maxDiff = Math.max(maxDiff, Math.abs(value - c[ci + k]));
			}
			if (!opaque) continue;
			compared++;
			total += maxDiff;
			if (maxDiff > VISIBLE_DIFF) visible++;
			if (maxDiff > SLIGHT_DIFF) slight++;
		}
	}
	if (compared === 0) return { visible: 0, slight: 0, mean: 0 };
	return { visible: visible / compared, slight: slight / compared, mean: total / compared };
};

const analyse = async (domain: Domain) => {
	const meta = (await (await fetch(`${DATA_URL}/${domain.value}/latest.json`)).json()) as {
		variables: string[];
	};
	const variable = meta.variables.includes('temperature_2m') ? 'temperature_2m' : meta.variables[0];
	const omUrl = `${DATA_URL}/${domain.value}/latest.json?variable=${variable}`;

	const grid = GridFactory.create(domain.grid, null);
	const centre = grid.getCenter();
	const spacing = gridSpacing(domain.grid, centre.lat);
	const resolution = gridResolutionZoom(domain.grid);

	// Read only the data around the centre: the zoom 2 tile holding it
	const z0 = 2;
	const tx = Math.floor(lon2tile(centre.lng, z0));
	const ty = Math.floor(lat2tile(centre.lat, z0));
	// `tile2lon` wraps 180 to -180, so the east edge is the west edge plus a tile
	const west = tile2lon(tx, z0);
	updateCurrentBounds([west, tile2lat(ty + 1, z0), west + 360 / 2 ** z0, tile2lat(ty, z0)]);

	const differences: Difference[] = [];
	let parent = await renderTile(omUrl, z0, tx, ty);
	for (let z = z0; z < MAX_ZOOM; z++) {
		const x = Math.floor(lon2tile(centre.lng, z + 1));
		const y = Math.floor(lat2tile(centre.lat, z + 1));
		const child = await renderTile(omUrl, z + 1, x, y);
		differences.push(difference(parent, child, x % 2, y % 2));
		parent = child;
	}
	// The first zoom from which on every finer zoom looks the same as its parent
	let measured = MAX_ZOOM;
	for (let i = differences.length - 1; i >= 0 && differences[i].visible < SAME_FRACTION; i--) {
		measured = z0 + i;
	}
	return { variable, spacing, resolution, measured, differences };
};

const wanted = process.argv.slice(2);
const domains = domainOptions.filter(
	(domain) => !isSeamlessDomain(domain) && (wanted.length === 0 || wanted.includes(domain.value))
);

console.log(
	'domain | grid | variable | spacing lon/lat (deg) | resolution zoom | measured zoom | per zoom step z2→3 … z11→12: visible% / slight% / mean'
);
for (const domain of domains) {
	try {
		const { variable, spacing, resolution, measured, differences } = await analyse(domain);
		const steps = differences
			.map(
				(d) => `${(d.visible * 100).toFixed(2)}/${(d.slight * 100).toFixed(1)}/${d.mean.toFixed(1)}`
			)
			.join(' ');
		console.log(
			`${domain.value} | ${domain.grid.type} | ${variable} | ${spacing.lon.toFixed(4)}/${spacing.lat.toFixed(4)} | ${resolution} | ${measured} | ${steps}`
		);
	} catch (err) {
		console.log(`${domain.value} | error: ${err instanceof Error ? err.message : err}`);
	}
}
