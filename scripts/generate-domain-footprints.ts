/**
 * Generates approximate non-NULL data footprints for reprojected regular-grid
 * seamless sub-domains (e.g. DWD ICON-D2, MF AROME France store data in a regular
 * lat/lon grid padded with NaN around the real, projected shape).
 *
 * For each such domain it loads one real `.om` file and traces a ring around the
 * valid (non-NaN) region: arched north/south edges joined by straight east/west
 * sides (see `traceFootprint`). It writes `src/domain-footprints.ts`, so the
 * seamless border follows the real data shape with no runtime data load. Re-run
 * with `npm run generate:footprints`.
 */
import { isSeamlessDomain, resolveConcreteDomain } from '../src/domain-helpers';
import { domainOptions } from '../src/domains';
import { WeatherMapLayerFileReader } from '../src/om-file-reader';
import { writeFileSync } from 'fs';

import type { Domain, RegularGridData } from '../src/types';

const BASE = 'https://map-tiles.open-meteo.com';
const MIN_NAN_FRACTION = 0.02; // below this the data ~fills the box; the box is fine
const ARCH_POLY_DEGREE = 4; // degree of the polynomial fitted to each north/south arch
const ARCH_SAMPLES = 25; // points sampled along each fitted arch (smooth, high-resolution)
const pad = (n: number) => String(n).padStart(2, '0');

type Pt = [number, number];

/** Collect the regular-grid sub-domains used by seamless domains (the blending layers). */
const regularSubDomains = (): Domain[] => {
	const seen = new Set<string>();
	const out: Domain[] = [];
	for (const d of domainOptions) {
		if (!isSeamlessDomain(d)) continue;
		// Skip the last (global fallback) layer — it never needs a footprint.
		for (const layer of d.layers.slice(0, -1)) {
			const concrete = resolveConcreteDomain(layer.domainValue, domainOptions);
			if (concrete && concrete.grid.type === 'regular' && !seen.has(concrete.value)) {
				seen.add(concrete.value);
				out.push(concrete);
			}
		}
	}
	return out;
};

const omUrlForLatest = async (domainValue: string): Promise<string | undefined> => {
	const res = await fetch(`${BASE}/data_spatial/${domainValue}/latest.json`);
	if (!res.ok) return undefined;
	const meta = (await res.json()) as { reference_time: string; valid_times: string[] };
	const ref = new Date(meta.reference_time);
	const t = new Date(meta.valid_times[0]);
	const run = `${ref.getUTCFullYear()}/${pad(ref.getUTCMonth() + 1)}/${pad(ref.getUTCDate())}/${pad(ref.getUTCHours())}${pad(ref.getUTCMinutes())}Z`;
	const file = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}`;
	return `${BASE}/data_spatial/${domainValue}/${run}/${file}.om`;
};

/** Solve A·x = b in place via Gaussian elimination with partial pivoting. */
const solveLinear = (A: number[][], b: number[]): number[] => {
	const n = b.length;
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let r = col + 1; r < n; r++) {
			if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
		}
		[A[col], A[pivot]] = [A[pivot], A[col]];
		[b[col], b[pivot]] = [b[pivot], b[col]];
		const diag = A[col][col] || 1e-12;
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const f = A[r][col] / diag;
			for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
			b[r] -= f * b[col];
		}
	}
	return b.map((v, i) => v / (A[i][i] || 1e-12));
};

/**
 * Least-squares polynomial fit y ≈ Σ cₖ·uᵏ where u = (x − mid)/half ∈ [-1, 1]
 * (normalized for numerical stability). Returns an evaluator over the raw x.
 * Fitting the whole staircase at once averages out the per-cell steps, yielding a
 * smooth arch that overlaps the staircase without tracking each riser.
 */
const fitPolynomial = (xs: number[], ys: number[], degree: number): ((x: number) => number) => {
	const xMin = xs[0];
	const xMax = xs[xs.length - 1];
	const mid = (xMin + xMax) / 2;
	const half = (xMax - xMin) / 2 || 1;
	const norm = (x: number) => (x - mid) / half;
	const deg = Math.min(degree, xs.length - 1);

	// Normal equations (Vandermonde)ᵀ·(Vandermonde)·c = (Vandermonde)ᵀ·y.
	const M: number[][] = Array.from({ length: deg + 1 }, () => new Array(deg + 1).fill(0));
	const rhs = new Array(deg + 1).fill(0);
	for (let i = 0; i < xs.length; i++) {
		const u = norm(xs[i]);
		const powers = [1];
		for (let k = 1; k <= 2 * deg; k++) powers.push(powers[k - 1] * u);
		for (let a = 0; a <= deg; a++) {
			for (let b = 0; b <= deg; b++) M[a][b] += powers[a + b];
			rhs[a] += ys[i] * powers[a];
		}
	}
	const coeffs = solveLinear(M, rhs);
	return (x: number) => {
		const u = norm(x);
		let p = 0;
		for (let k = coeffs.length - 1; k >= 0; k--) p = p * u + coeffs[k];
		return p;
	};
};

/**
 * Fit a smooth arch to the columns between corner indices `iFrom`..`iTo` and
 * sample it at `ARCH_SAMPLES` points, walking longitude from `iFrom` to `iTo`.
 * Replaces the cell-level staircase with a high-resolution curve.
 */
const fitArch = (lon: number[], lat: number[], iFrom: number, iTo: number): Pt[] => {
	const lo = Math.min(iFrom, iTo);
	const hi = Math.max(iFrom, iTo);
	const xs = lon.slice(lo, hi + 1);
	const ys = lat.slice(lo, hi + 1);
	if (xs.length < 2) return [[lon[iFrom], lat[iFrom]]];

	const f = fitPolynomial(xs, ys, ARCH_POLY_DEGREE);
	const lonFrom = lon[iFrom];
	const lonTo = lon[iTo];
	const pts: Pt[] = [];
	for (let k = 0; k < ARCH_SAMPLES; k++) {
		const t = k / (ARCH_SAMPLES - 1);
		const x = lonFrom + t * (lonTo - lonFrom);
		pts.push([x, f(x)]);
	}
	return pts;
};

/** Median filter to remove cell-level jitter and stray-cell spikes from an edge. */
const medianFilter = (a: number[], w: number): number[] => {
	const half = w >> 1;
	return a.map((_, i) => {
		const s = a
			.slice(Math.max(0, i - half), Math.min(a.length, i + half + 1))
			.sort((p, q) => p - q);
		return s[s.length >> 1];
	});
};

/**
 * Trace a closed [lon,lat] ring around the valid (non-NaN) cells, shaped as
 * arched north/south edges joined by straight east/west sides.
 *
 * For every column we take the lowest/highest valid row (the south/north
 * boundary), median-smooth those to kill cell-level jitter and stray-cell spikes,
 * then locate the four corners as rotated extremes. The north edge (NW→NE) and
 * south edge (SW→SE) are each replaced by a smooth polynomial arch fitted to their
 * columns and sampled at high resolution — this discards the cell staircase while
 * keeping the true curvature. The sides are the straight corner-to-corner joins.
 */
const traceFootprint = (values: Float32Array, grid: RegularGridData): Pt[] | undefined => {
	const { nx, ny, lonMin, latMin, dx, dy } = grid;
	const lon: number[] = [];
	const botRaw: number[] = [];
	const topRaw: number[] = [];
	for (let x = 0; x < nx; x++) {
		let minY = -1;
		let maxY = -1;
		for (let y = 0; y < ny; y++) {
			if (!Number.isNaN(values[y * nx + x])) {
				if (minY < 0) minY = y;
				maxY = y;
			}
		}
		if (minY < 0) continue;
		lon.push(lonMin + x * dx);
		botRaw.push(latMin + minY * dy);
		topRaw.push(latMin + maxY * dy);
	}
	if (lon.length < 4) return undefined;

	const win = Math.max(5, Math.round(lon.length / 40)) | 1; // odd window ~1/40 of the span
	const bot = medianFilter(botRaw, win);
	const top = medianFilter(topRaw, win);

	// Corners as rotated extremes (robust to a tilted rectangle and a mild arch).
	let iNW = 0;
	let iNE = 0;
	let iSW = 0;
	let iSE = 0;
	for (let i = 1; i < lon.length; i++) {
		if (top[i] - lon[i] > top[iNW] - lon[iNW]) iNW = i; // max(lat - lon)
		if (top[i] + lon[i] > top[iNE] + lon[iNE]) iNE = i; // max(lat + lon)
		if (-bot[i] - lon[i] > -bot[iSW] - lon[iSW]) iSW = i; // min(lat + lon)
		if (-bot[i] + lon[i] > -bot[iSE] + lon[iSE]) iSE = i; // min(lat - lon)
	}

	// South arch (SW→SE), then north arch (NE→NW); the gaps are the straight sides.
	const south = fitArch(lon, bot, iSW, iSE);
	const north = fitArch(lon, top, iNE, iNW);
	const ring = [...south, ...north];
	ring.push(ring[0]); // close
	return ring.map(([l, la]) => [Number(l.toFixed(3)), Number(la.toFixed(3))]);
};

const main = async () => {
	const footprints: Record<string, Pt[]> = {};
	for (const domain of regularSubDomains()) {
		const grid = domain.grid as RegularGridData;
		const url = await omUrlForLatest(domain.value);
		if (!url) {
			console.warn(`! ${domain.value}: no latest.json — skipped`);
			continue;
		}
		const reader = new WeatherMapLayerFileReader({ useSAB: false });
		try {
			await reader.setToOmFile(url);
			const { values } = await reader.readVariable('temperature_2m', null);
			if (!values) throw new Error('no values');
			let nan = 0;
			for (let i = 0; i < values.length; i++) if (Number.isNaN(values[i])) nan++;
			const frac = nan / values.length;
			if (frac < MIN_NAN_FRACTION) {
				console.log(`· ${domain.value}: ${(frac * 100).toFixed(1)}% NaN — fills box, skipped`);
				continue;
			}
			const ring = traceFootprint(values, grid);
			if (!ring) {
				console.warn(`! ${domain.value}: could not trace footprint`);
				continue;
			}
			footprints[domain.value] = ring;
			console.log(`✓ ${domain.value}: ${(frac * 100).toFixed(1)}% NaN → ${ring.length} points`);
		} catch (e) {
			console.warn(`! ${domain.value}: ${(e as Error).message}`);
		} finally {
			reader.dispose();
		}
	}

	const body =
		`// AUTO-GENERATED by scripts/generate-domain-footprints.ts — do not edit by hand.\n` +
		`// Approximate non-NULL data footprints (closed [lon, lat] rings) for reprojected\n` +
		`// regular-grid domains, so seamless borders follow the real data shape instead of\n` +
		`// the rectangular grid box. Regenerate with: npm run generate:footprints\n\n` +
		`export const DOMAIN_FOOTPRINTS: Record<string, Array<[number, number]>> = ${JSON.stringify(
			footprints,
			null,
			'\t'
		)};\n\n` +
		`/** Returns the precomputed data-shape outline for a domain, if one exists. */\n` +
		`export const getDomainFootprint = (\n\tdomainValue: string\n): Array<[number, number]> | undefined => DOMAIN_FOOTPRINTS[domainValue];\n`;

	writeFileSync(new URL('../src/domain-footprints.ts', import.meta.url), body);
	console.log(`\nWrote src/domain-footprints.ts (${Object.keys(footprints).length} domains)`);
};

main();
