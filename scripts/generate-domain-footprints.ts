/**
 * Generates approximate non-NULL data footprints for domains whose files are
 * padded with NaN around the real data region, so the drawn boundary follows the
 * data instead of the grid box:
 *
 * - Reprojected regular-grid seamless sub-domains (e.g. DWD ICON-D2, MF AROME
 *   France store data in a regular lat/lon grid padded with NaN around the real,
 *   projected shape). Their outline is traced as four smooth polynomial arches —
 *   north/south and east/west, since a reprojected grid curves on every side
 *   (see `traceFootprint`).
 * - Projected grids listed in `PROJECTED_FOOTPRINT_DOMAINS` (e.g. RRFS North
 *   America, whose rotated grid box reaches around the pole while the data is
 *   masked to the compute domain). These are traced in their own projected space,
 *   where the grid is regular, and reverse-projected point-by-point (see
 *   `traceProjectedFootprint`): a sparse fitted arch does not survive
 *   reprojection, because straight segments between samples cut corners wherever
 *   the projection curves — worst near the poles.
 *
 * For each domain it loads one real `.om` file and writes `src/domain-footprints.ts`,
 * so the border follows the real data shape with no runtime data load. Re-run with
 * `npm run generate:footprints`.
 */
import { isSeamlessDomain, resolveConcreteDomain } from '../src/domain-helpers';
import { domainOptions } from '../src/domains';
import { GridFactory } from '../src/grids/index';
import type { Projection } from '../src/grids/projections';
import { WeatherMapLayerFileReader } from '../src/om-file-reader';
import { writeFileSync } from 'fs';

import type { Domain, RegularGridData } from '../src/types';

const BASE = 'https://data-spatial.open-meteo.com';
const MIN_NAN_FRACTION = 0.02; // below this the data ~fills the box; the box is fine
const ARCH_POLY_DEGREE = 4; // degree of the polynomial fitted to each north/south arch
const ARCH_SAMPLES = 25; // points sampled along each fitted arch (smooth, high-resolution)
const SIMPLIFY_TOLERANCE_DEG = 0.05; // Douglas–Peucker tolerance for projected-grid rings
const BOUNDARY_SMOOTH_WINDOW = 11; // cells averaged along the ring to iron out the cell staircase
const pad = (n: number) => String(n).padStart(2, '0');

// The data server validates the Referer; the reader's internal range requests
// need it too, so patch fetch globally rather than per request.
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) =>
	originalFetch(input, {
		...init,
		headers: { ...(init.headers ?? {}), Referer: 'https://maps.open-meteo.com/' }
	})) as typeof fetch;

/** NaN-padded projected grids that need a data footprint (in addition to the
 * regular-grid seamless sub-domains, which are discovered automatically). */
const PROJECTED_FOOTPRINT_DOMAINS = ['ncep_rrfs_north_america'];

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
 * Fit a smooth arch `dep ≈ poly(indep)` between corner indices `iFrom`..`iTo` and
 * sample it at `ARCH_SAMPLES` points, walking `indep` from `iFrom` to `iTo`. Returns
 * `[indep, dep]` pairs. Used for both the N/S edges (indep = lon, dep = lat) and the
 * E/W edges (indep = lat, dep = lon), replacing the cell staircase with a curve.
 */
const fitArch = (indep: number[], dep: number[], iFrom: number, iTo: number): Pt[] => {
	const lo = Math.min(iFrom, iTo);
	const hi = Math.max(iFrom, iTo);
	const xs = indep.slice(lo, hi + 1);
	const ys = dep.slice(lo, hi + 1);
	if (xs.length < 2) return [[indep[iFrom], dep[iFrom]]];

	const f = fitPolynomial(xs, ys, ARCH_POLY_DEGREE);
	const from = indep[iFrom];
	const to = indep[iTo];
	const pts: Pt[] = [];
	for (let k = 0; k < ARCH_SAMPLES; k++) {
		const t = k / (ARCH_SAMPLES - 1);
		const x = from + t * (to - from);
		pts.push([x, f(x)]);
	}
	return pts;
};

/** Index in `arr` whose value is closest to `val`. */
const nearestIndex = (arr: number[], val: number): number => {
	let best = 0;
	let bestDist = Infinity;
	for (let i = 0; i < arr.length; i++) {
		const d = Math.abs(arr[i] - val);
		if (d < bestDist) {
			bestDist = d;
			best = i;
		}
	}
	return best;
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

/** Per-column bottom/top and per-row left/right extents of the non-NaN region,
 * median-smoothed, in grid coordinates `min + index * step` of the given axes. */
const scanValidEdges = (
	values: Float32Array,
	nx: number,
	ny: number,
	xMin: number,
	yMin: number,
	dx: number,
	dy: number
) => {
	// Column scan: south/north extent of each column.
	const colX: number[] = [];
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
		colX.push(xMin + x * dx);
		botRaw.push(yMin + minY * dy);
		topRaw.push(yMin + maxY * dy);
	}

	// Row scan: west/east extent of each row.
	const rowY: number[] = [];
	const leftRaw: number[] = [];
	const rightRaw: number[] = [];
	for (let y = 0; y < ny; y++) {
		let minX = -1;
		let maxX = -1;
		for (let x = 0; x < nx; x++) {
			if (!Number.isNaN(values[y * nx + x])) {
				if (minX < 0) minX = x;
				maxX = x;
			}
		}
		if (minX < 0) continue;
		rowY.push(yMin + y * dy);
		leftRaw.push(xMin + minX * dx);
		rightRaw.push(xMin + maxX * dx);
	}
	if (colX.length < 4 || rowY.length < 4) return undefined;

	const winCol = Math.max(5, Math.round(colX.length / 40)) | 1; // odd window ~1/40 of the span
	const winRow = Math.max(5, Math.round(rowY.length / 40)) | 1;
	return {
		colX,
		bot: medianFilter(botRaw, winCol),
		top: medianFilter(topRaw, winCol),
		rowY,
		left: medianFilter(leftRaw, winRow),
		right: medianFilter(rightRaw, winRow)
	};
};

/**
 * Trace a closed [lon,lat] ring around the valid (non-NaN) cells, shaped as four
 * smooth arches — because a reprojected grid's edges are all curved, not just the
 * north/south ones.
 *
 * A column scan gives the south/north latitude of every column and a row scan gives
 * the west/east longitude of every row; both are median-smoothed to kill cell-level
 * jitter and stray-cell spikes. The four corners are located as rotated extremes.
 * Each edge is then a polynomial arch: N/S fit lat over lon, E/W fit lon over lat,
 * sampled at high resolution — discarding the cell staircase while keeping the true
 * curvature on every side.
 */
const traceFootprint = (values: Float32Array, grid: RegularGridData): Pt[] | undefined => {
	const { nx, ny, lonMin, latMin, dx, dy } = grid;
	const edges = scanValidEdges(values, nx, ny, lonMin, latMin, dx, dy);
	if (!edges) return undefined;
	const { colX: lon, bot, top, rowY: lat, left, right } = edges;

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

	// Latitudes of the corners, used to bound the E/W arches in the row scan.
	const rSE = nearestIndex(lat, bot[iSE]);
	const rNE = nearestIndex(lat, top[iNE]);
	const rNW = nearestIndex(lat, top[iNW]);
	const rSW = nearestIndex(lat, bot[iSW]);

	// Walk the perimeter: south (SW→SE), east (SE→NE), north (NE→NW), west (NW→SW).
	// N/S arches fit lat over lon; E/W arches fit lon over lat (swap back to [lon,lat]).
	const south = fitArch(lon, bot, iSW, iSE);
	const east = fitArch(lat, right, rSE, rNE).map(([la, lo]): Pt => [lo, la]);
	const north = fitArch(lon, top, iNE, iNW);
	const west = fitArch(lat, left, rNW, rSW).map(([la, lo]): Pt => [lo, la]);

	// The four arches are fitted independently, so at each corner the two
	// adjacent fits give slightly different estimates of the same point; joined
	// raw, the ring doubles back through a thin self-crossing wedge — an ugly
	// spike once zoomed in. Weld each junction to the midpoint of both estimates.
	const weld = (a: Pt[], b: Pt[]): void => {
		const end = a[a.length - 1];
		const start = b[0];
		const corner: Pt = [(end[0] + start[0]) / 2, (end[1] + start[1]) / 2];
		a[a.length - 1] = corner;
		b[0] = corner;
	};
	weld(south, east);
	weld(east, north);
	weld(north, west);
	weld(west, south);

	// Welded junctions duplicate their corner vertex; keep one of each. The
	// last west point equals the first south point, closing the ring itself.
	const ring: Pt[] = [];
	for (const pt of [...south, ...east, ...north, ...west]) {
		const prev = ring[ring.length - 1];
		if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) ring.push(pt);
	}
	if (ring[ring.length - 1][0] !== ring[0][0] || ring[ring.length - 1][1] !== ring[0][1]) {
		ring.push(ring[0]);
	}
	return ring.map(([l, la]) => [Number(l.toFixed(3)), Number(la.toFixed(3))]);
};

/** Douglas–Peucker simplification of an open polyline (endpoints are kept). */
const simplifyPolyline = (pts: Pt[], tolerance: number): Pt[] => {
	if (pts.length <= 2) return pts;
	const keep = new Array<boolean>(pts.length).fill(false);
	keep[0] = keep[pts.length - 1] = true;
	const stack: Array<[number, number]> = [[0, pts.length - 1]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		const [ax, ay] = pts[a];
		const [bx, by] = pts[b];
		const dx = bx - ax;
		const dy = by - ay;
		const len2 = dx * dx + dy * dy;
		let worst = -1;
		let worstDist = tolerance;
		for (let i = a + 1; i < b; i++) {
			const [px, py] = pts[i];
			// Perpendicular distance to the a→b chord (degenerate chord → point distance).
			const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
			const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
			if (d > worstDist) {
				worstDist = d;
				worst = i;
			}
		}
		if (worst >= 0) {
			keep[worst] = true;
			stack.push([a, worst], [worst, b]);
		}
	}
	return pts.filter((_, i) => keep[i]);
};

/** The projected-grid fields `traceProjectedFootprint` needs (see ProjectedGrid). */
interface ProjectedGridLike {
	nx: number;
	ny: number;
	dx: number;
	dy: number;
	origin: [number, number];
	projection: Projection;
}

/**
 * Ordered boundary cells of the valid (non-NaN) region, found with Moore
 * neighbour tracing. One pass around the region yields every boundary cell
 * exactly once in walking order — unlike stitching per-row/per-column extent
 * scans, which cover the same boundary arc twice near corners and steep
 * sections and so draw a doubled, slightly offset line.
 */
const traceMaskBoundary = (
	values: Float32Array,
	nx: number,
	ny: number
): Array<[number, number]> | undefined => {
	const valid = (x: number, y: number): boolean =>
		x >= 0 && y >= 0 && x < nx && y < ny && !Number.isNaN(values[y * nx + x]);

	// Start on the outer boundary of the main region: the bottom-most valid cell
	// of the column holding the most valid cells (immune to stray specks elsewhere).
	let startX = -1;
	let bestCount = 0;
	for (let x = 0; x < nx; x++) {
		let count = 0;
		for (let y = 0; y < ny; y++) if (valid(x, y)) count++;
		if (count > bestCount) {
			bestCount = count;
			startX = x;
		}
	}
	if (startX < 0) return undefined;
	let startY = 0;
	while (!valid(startX, startY)) startY++;

	// Moore neighbourhood in clockwise order, starting east.
	const DIRS: Array<[number, number]> = [
		[1, 0],
		[1, -1],
		[0, -1],
		[-1, -1],
		[-1, 0],
		[-1, 1],
		[0, 1],
		[1, 1]
	];
	const boundary: Array<[number, number]> = [[startX, startY]];
	let cx = startX;
	let cy = startY;
	// The backtrack neighbour (the invalid cell the search enters from); the cell
	// below the bottom-most start cell is invalid by construction.
	let backtrack = DIRS.findIndex(([dx, dy]) => dx === 0 && dy === -1);
	const maxSteps = 8 * (nx + ny);
	for (let step = 0; step < maxSteps; step++) {
		// Scan clockwise from the neighbour after the backtrack direction.
		let next = -1;
		for (let i = 1; i <= 8; i++) {
			const dir = (backtrack + i) % 8;
			if (valid(cx + DIRS[dir][0], cy + DIRS[dir][1])) {
				next = dir;
				break;
			}
		}
		if (next < 0) return boundary; // isolated cell
		cx += DIRS[next][0];
		cy += DIRS[next][1];
		// Entering the next cell, the search came from the previous one.
		backtrack = (next + 4) % 8;
		if (cx === startX && cy === startY) return boundary;
		boundary.push([cx, cy]);
	}
	return undefined; // did not close — malformed mask
};

/**
 * Circular moving average over a closed ring of grid positions. The traced
 * boundary is a cell staircase; averaging over a window along the ring runs the
 * line through the middle of the stairs — the drawn outline stays smooth like a
 * fitted curve while still following every real bend of the mask.
 */
const smoothRing = (ring: Array<[number, number]>, window: number): Array<[number, number]> => {
	const half = window >> 1;
	const n = ring.length;
	return ring.map((_, i) => {
		let sx = 0;
		let sy = 0;
		for (let j = -half; j <= half; j++) {
			const [x, y] = ring[(((i + j) % n) + n) % n];
			sx += x;
			sy += y;
		}
		return [sx / (2 * half + 1), sy / (2 * half + 1)];
	});
};

/**
 * Trace a closed [lon,lat] ring around the valid (non-NaN) cells of a projected
 * grid. The boundary is walked in the grid's own index space, where it is
 * regular, smoothed there (isotropic cells), then reverse-projected point-by-point
 * and only afterwards simplified in geographic space. Fitted arches are
 * deliberately not used here: straight segments between sparse samples cut
 * corners wherever the projection curves (worst near the poles), while
 * Douglas–Peucker applied after reprojection keeps points exactly where the
 * outline actually bends.
 *
 * Longitudes are unwrapped relative to the previous vertex, exactly like
 * `getBoundaryPolygon`, so the ring stays continuous across the antimeridian; for
 * a ring enclosing a pole the end point equals the start point shifted by 360°.
 */
const traceProjectedFootprint = (
	values: Float32Array,
	grid: ProjectedGridLike
): Pt[] | undefined => {
	const traced = traceMaskBoundary(values, grid.nx, grid.ny);
	if (!traced || traced.length < 8) return undefined;
	const boundary = smoothRing(traced, BOUNDARY_SMOOTH_WINDOW);
	boundary.push(boundary[0]); // close the ring

	let prevLon: number | null = null;
	const ring: Pt[] = [];
	for (const [x, y] of boundary) {
		const px = grid.origin[0] + x * grid.dx;
		const py = grid.origin[1] + y * grid.dy;
		const [lat, lonRaw] = grid.projection.reverse(px, py);
		let lon = ((((lonRaw + 180) % 360) + 360) % 360) - 180; // normalize to [-180, 180]
		if (prevLon !== null) {
			lon -= 360 * Math.round((lon - prevLon) / 360);
		}
		prevLon = lon;
		const prev = ring[ring.length - 1];
		if (!prev || prev[0] !== lon || prev[1] !== lat) ring.push([lon, lat]);
	}

	return simplifyPolyline(ring, SIMPLIFY_TOLERANCE_DEG).map(([l, la]) => [
		Number(l.toFixed(3)),
		Number(la.toFixed(3))
	]);
};

const main = async () => {
	const projectedDomains = PROJECTED_FOOTPRINT_DOMAINS.map((value) => {
		const domain = domainOptions.find((d) => d.value === value);
		if (!domain) throw new Error(`unknown domain in PROJECTED_FOOTPRINT_DOMAINS: ${value}`);
		return domain;
	});

	const footprints: Record<string, Pt[]> = {};
	for (const domain of [...regularSubDomains(), ...projectedDomains]) {
		const url = await omUrlForLatest(domain.value);
		if (!url) {
			console.warn(`! ${domain.value}: no latest.json — skipped`);
			continue;
		}
		const reader = new WeatherMapLayerFileReader({ useSAB: false });
		try {
			const { values } = await reader.readVariable(url, 'temperature_2m', null);
			if (!values) throw new Error('no values');
			let nan = 0;
			for (let i = 0; i < values.length; i++) if (Number.isNaN(values[i])) nan++;
			const frac = nan / values.length;
			if (frac < MIN_NAN_FRACTION) {
				console.log(`· ${domain.value}: ${(frac * 100).toFixed(1)}% NaN — fills box, skipped`);
				continue;
			}
			const ring =
				domain.grid.type === 'regular'
					? traceFootprint(values, domain.grid)
					: traceProjectedFootprint(
							values,
							GridFactory.create(domain.grid, null) as unknown as ProjectedGridLike
						);
			if (!ring) {
				console.warn(`! ${domain.value}: could not trace footprint`);
				continue;
			}
			footprints[domain.value] = ring;
			console.log(`✓ ${domain.value}: ${(frac * 100).toFixed(1)}% NaN → ${ring.length} points`);
		} catch (e) {
			console.warn(`! ${domain.value}: ${(e as Error).message}`);
		}
	}

	const body =
		`// AUTO-GENERATED by scripts/generate-domain-footprints.ts — do not edit by hand.\n` +
		`// Approximate non-NULL data footprints (closed [lon, lat] rings) for NaN-padded\n` +
		`// grids, so domain borders follow the real data shape instead of the rectangular\n` +
		`// grid box. Regenerate with: npm run generate:footprints\n` +
		`import { GridFactory } from './grids/index';\n\n` +
		`import type { Domain } from './types';\n\n` +
		`const DOMAIN_FOOTPRINTS: Record<string, Array<[number, number]>> = ${JSON.stringify(
			footprints,
			null,
			'\t'
		)};\n\n` +
		`/**\n` +
		` * Returns the domain's outline as a closed \`[lon, lat]\` ring: the precomputed\n` +
		` * data-shape footprint when one exists (NULL-padded grids whose real data region\n` +
		` * is smaller than the grid box), otherwise the grid's boundary polygon\n` +
		` * (\`getBoundaryPolygon\`). Rings unwrap longitudes like \`getBoundaryPolygon\`:\n` +
		` * one enclosing a pole ends 360° east of where it starts.\n` +
		` */\n` +
		`export const getDomainBoundary = (domain: Domain): Array<[number, number]> =>\n` +
		`\tDOMAIN_FOOTPRINTS[domain.value] ?? GridFactory.create(domain.grid, null).getBoundaryPolygon();\n`;

	writeFileSync(new URL('../src/domain-footprints.ts', import.meta.url), body);
	console.log(`\nWrote src/domain-footprints.ts (${Object.keys(footprints).length} domains)`);
};

main();
