import {
	lat2tile,
	lon2tile,
	radiansToDegrees,
	roundWithPrecision,
	tile2lat,
	tile2lon
} from '../../utils/math';
import { GridInterface, GridPoint } from '../interface';

import { ICON_WARP_TABLES } from './icon-warp-tables';

import { Bounds, DimensionRange, IconGridData, InterpolationMethod } from '../../types';

// Native ICON icosahedral-triangular grid (analytical + embedded warp table,
// no grid file needed).
//
// The ICON R{n}B{k} grid starts from a regular icosahedron oriented with one
// vertex on each pole. Each of the 20 spherical faces is divided into n²
// root triangles (every edge split into n equal great-circle arcs), and each
// root triangle is then bisected k times (each level splits a triangle into
// 4: three corner children and one inverted centre child, using spherical
// edge midpoints). The global 13 km grid is R3B07: 20 · 3² · 4⁷ = 2,949,120
// cells.
//
// Cell ordering and orientation follow the official DWD/MPI-M grid files
// (verified against icon_grid_0024_R02B06_G, 0036_R03B06_G and
// 0026_R03B07_G):
//   - the icosahedron's upper vertex ring sits at lon 36° + i·72°, the lower
//     ring at 72° + i·72°;
//   - faces are ordered north cap (0-4), downward belt (5-9), upward belt
//     (10-14), south cap (15-19), with vertex orders (np, uᵢ, uᵢ₊₁),
//     (lᵢ, uᵢ₊₁, uᵢ), (uᵢ₊₁, lᵢ, lᵢ₊₁) and (sp, lᵢ₊₁, lᵢ);
//   - root triangles are row-major from the face apex v0: upright T(i,j) at
//     index r² + 2j (r = i+j) with vertices (L(i,j), L(i+1,j), L(i,j+1)),
//     inverted T'(i,j) at (i+j+1)² + 2j + 1 with vertices
//     (L(i+1,j+1), L(i,j+1), L(i+1,j));
//   - each bisection level appends one digit (most significant first):
//       index = (face · n² + rootLocal) · 4^k + d₁·4^(k-1) + … + d_k
//     with d = 0: corner child at v0 → (v0, m01, m20)
//          d = 1: corner child at v1 → (m01, v1, m12)
//          d = 2: centre child       → (m12, m20, m01)
//          d = 3: corner child at v2 → (m20, m12, v2)
//     where m01/m12/m20 are the normalized (spherical) edge midpoints.
//
// DWD optimizes the vertex positions with spring dynamics, displacing the
// operational grid from this geometric construction by a smooth,
// locally-rigid warp of ~21 km mean / 65 km max (R3 family; ~36 km at
// R2B06), largest towards the 12 pentagon points. That warp is corrected
// here with an embedded table (icon-warp-tables.ts) extracted from the
// official grid files: true positions of the subdivision vertices on a
// coarse base lattice (level 5), plus exact full-resolution patches around
// the pentagon points where the warp field has kinks. Cell vertices are
// warped by interpolating the table, and the cell centre is the spherical
// circumcenter of the warped triangle — matching ICON's mass-point
// definition. Residual vs the operational grids: ~38 m mean / 0.53 km max
// (R3B07), ~34 m / 0.6 km (R3B06, same table), ~71 m / 0.95 km (R2B06).
// Grids without a table for their root division fall back to the pure
// geometric construction.
//
// Point location descends the geometric hierarchy: face via arg-max against
// the 20 face centres (exact — the perpendicular bisector plane of two
// adjacent face centres contains their shared edge), root triangle via
// great-circle-side tests, then one sign test per bisection level. All
// boundaries are great circles through the subdivision vertices, so the
// tests are exact for the geometric grid; with a warp table the query point
// is inverse-warped first. Away from the pentagon points the leaf-level
// warp equals the base-lattice interpolation (linear composition), so one
// fixed-point step over a cheap partial descent suffices; near the pentagon
// points (patch detail, larger gradients) two accurate steps are used. The
// base samples are unpacked to 3D offsets once at construction. Verified:
// findCell(cellCoordinates(i)) == i for every cell of R2B03/R2B06/R3B06/
// R3B07, at roughly the speed of the uncorrected geometric grid.

type Vec3 = [number, number, number];

interface RootTriangle {
	v0: Vec3;
	v1: Vec3;
	v2: Vec3;
	// unit inward normals of the three edge planes, for containment scoring
	n01: Vec3;
	n12: Vec3;
	n20: Vec3;
	// integer corner coordinates in the face lattice (resolution n·2^k),
	// order matching v0/v1/v2 — used for warp-table lookups
	c: [number, number, number, number, number, number];
}

interface Face {
	// face centroid (unnormalized is fine for the arg-max test)
	center: Vec3;
	// root triangles in rootLocal order, generator vertex order
	roots: RootTriangle[];
}

// decoded warp table (see icon-warp-tables.ts for the binary layout)
interface WarpTable {
	tableK: number; // bisection level the table was extracted at
	baseLevel: number; // base lattice subdivision level
	patchRadius: number; // pentagon patch radius, in table lattice units
	quantChord: number; // metres-per-LSB converted to unit-sphere chord
	baseRes: number; // n · 2^baseLevel
	tableRes: number; // n · 2^tableK
	perFaceBase: number;
	perPatch: number;
	base: Int16Array;
	patches: Int16Array;
}

// leaf triangle + the context the warp evaluation needs
interface LeafContext {
	face: number;
	v0: Vec3;
	v1: Vec3;
	v2: Vec3;
	// integer corner coordinates (face lattice, resolution n·2^k)
	c: [number, number, number, number, number, number];
	// triangle at the base-lattice capture level: geometry + lattice coords
	lbV: [Vec3, Vec3, Vec3];
	lbC: [number, number, number, number, number, number];
}

const EARTH_RADIUS_M = 6371229; // ICON grid sphere (semi_major_axis)

const cross = (u: Vec3, v: Vec3): Vec3 => [
	u[1] * v[2] - u[2] * v[1],
	u[2] * v[0] - u[0] * v[2],
	u[0] * v[1] - u[1] * v[0]
];

const dot = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

const normalize = (v: Vec3): Vec3 => {
	// Math.sqrt instead of Math.hypot: ~2x faster, and overflow safety is
	// irrelevant for unit-scale vectors
	const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
	return [v[0] / l, v[1] / l, v[2] / l];
};

// normalized (spherical) edge midpoint
const mid = (u: Vec3, v: Vec3): Vec3 => {
	const x = u[0] + v[0];
	const y = u[1] + v[1];
	const z = u[2] + v[2];
	const l = Math.sqrt(x * x + y * y + z * z);
	return [x / l, y / l, z / l];
};

// spherical linear interpolation along the great circle from a to b
const slerp = (a: Vec3, b: Vec3, t: number): Vec3 => {
	const omega = Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
	if (omega < 1e-12) return a;
	const sa = Math.sin((1 - t) * omega) / Math.sin(omega);
	const sb = Math.sin(t * omega) / Math.sin(omega);
	return [sa * a[0] + sb * b[0], sa * a[1] + sb * b[1], sa * a[2] + sb * b[2]];
};

const latLonToVec = (latDeg: number, lonDeg: number): Vec3 => {
	const lat = (latDeg * Math.PI) / 180;
	const lon = (lonDeg * Math.PI) / 180;
	const cosLat = Math.cos(lat);
	return [cosLat * Math.cos(lon), cosLat * Math.sin(lon), Math.sin(lat)];
};

// deterministic local (east, north) tangent frame; falls back to lon = 0 at
// the poles. Must match the table generator exactly.
const tangentFrame = (g: Vec3): [Vec3, Vec3] => {
	const horiz = Math.hypot(g[0], g[1]);
	if (horiz < 1e-9) {
		return [
			[0, 1, 0],
			[g[2] > 0 ? -1 : 1, 0, 0]
		];
	}
	const e: Vec3 = [-g[1] / horiz, g[0] / horiz, 0];
	return [e, normalize(cross(g, e))];
};

const decodeWarpTable = (b64: string): WarpTable => {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	const arr = new Int16Array(bytes.buffer);
	const n = arr[1];
	const tableK = arr[2];
	const baseLevel = arr[3];
	const patchRadius = arr[4];
	const quantMm = arr[5];
	const baseRes = n * 2 ** baseLevel;
	const perFaceBase = ((baseRes + 1) * (baseRes + 2)) / 2;
	const perPatch = ((patchRadius + 1) * (patchRadius + 2)) / 2;
	return {
		tableK,
		baseLevel,
		patchRadius,
		quantChord: quantMm / 1000 / EARTH_RADIUS_M,
		baseRes,
		tableRes: n * 2 ** tableK,
		perFaceBase,
		perPatch,
		base: arr.subarray(6, 6 + 20 * perFaceBase * 2),
		patches: arr.subarray(6 + 20 * perFaceBase * 2)
	};
};

// one triangular-lattice bisection step: fine vertices are copies of coarse
// ones or spherical midpoints of the coarse edge pairs (horizontal, vertical
// or hypotenuse by parity) — exactly the pairs the triangle descent bisects
const refineLattice = (coarse: Vec3[][]): Vec3[][] => {
	const R = 2 * (coarse.length - 1);
	const fine: Vec3[][] = [];
	for (let i = 0; i <= R; i++) {
		fine.push([]);
		for (let j = 0; j <= R - i; j++) {
			let p: Vec3;
			if (i % 2 === 0 && j % 2 === 0) p = coarse[i / 2][j / 2];
			else if (j % 2 === 0) p = mid(coarse[(i - 1) / 2][j / 2], coarse[(i + 1) / 2][j / 2]);
			else if (i % 2 === 0) p = mid(coarse[i / 2][(j - 1) / 2], coarse[i / 2][(j + 1) / 2]);
			else p = mid(coarse[(i + 1) / 2][(j - 1) / 2], coarse[(i - 1) / 2][(j + 1) / 2]);
			fine[i].push(p);
		}
	}
	return fine;
};

const UPPER_LAT = radiansToDegrees(Math.atan(0.5)); // ±26.565° vertex rings

export class IconGrid implements GridInterface {
	// should always be 1 for icon grids (values are one flat cell array)
	private readonly ny: number;
	// nx contains all grid cells in a single dimension
	private readonly nx: number;
	// shifts indices when accessing partially-read data (see GaussianGrid)
	private readonly nxStart: number;

	private readonly n: number; // root division (R3 → 3)
	private readonly k: number; // bisection levels (B07 → 7)
	private readonly cellsPerRoot: number; // 4^k
	private readonly cellsPerFace: number; // n² · 4^k

	private readonly faces: Face[];
	private readonly warp: WarpTable | null;
	// descent level at which the base-lattice triangle is captured
	private readonly captureLevel: number;
	// base warp samples pre-decoded to 3D offsets (face-major, lattice order):
	// avoids per-lookup tangent-frame math on the hot path
	private readonly baseWarp: Float64Array | null = null;
	// L5-lattice distance from a face corner below which the accurate
	// (pentagon-patch) path is used; equals patchRadius in base-lattice units,
	// so cold cells can never touch a patched vertex
	private readonly hotThreshold: number = 0;
	// per-face root lattices, kept only until the warp decode has run
	private readonly rootLattices: Vec3[][][] = [];

	// Coarse (inverse-warp) context cache: partialLocate is a deterministic
	// function of the query point, so its result can be reused for any (true)
	// point strictly inside the cached coarse triangle. Only cold (non-pentagon)
	// contexts are cached; hot points take the full accurate inverse.
	private icCacheValid = false;
	private icN12: Vec3 = [0, 0, 0];
	private icN20: Vec3 = [0, 0, 0];
	private icN01: Vec3 = [0, 0, 0];
	private icOrient = 1;
	private icMargin = 0;
	private icCtx: Pick<LeafContext, 'face' | 'lbV' | 'lbC'> | null = null;

	// findCell leaf cache (independent of the barycentric one): reuse the located
	// cell for any inverse-warped point strictly inside its geometric leaf
	// triangle — speeds the raster build scan and repeated nearest-neighbour calls.
	private fcCacheValid = false;
	private fcN12: Vec3 = [0, 0, 0];
	private fcN20: Vec3 = [0, 0, 0];
	private fcN01: Vec3 = [0, 0, 0];
	private fcOrient = 1;
	private fcMargin = 0;
	private fcIndex = 0;

	// last-located (face,root), used to seed locateVec's descent and skip the
	// global face/root search when a nearby query lands in the same root.
	private seedValid = false;
	private seedFace = 0;
	private seedRoot = 0;

	// Dual-face interpolation cache: the ring of cell centres around a primal
	// vertex (a "dual face"). These tile the true sphere, so a query strictly
	// inside the cached ring polygon reuses it — fan-triangulated barycentric
	// interpolation over the ring is C0 (no faceting) and reproduces cell values.
	private dfCacheValid = false;
	private dfCount = 0;
	private dfCenters: Vec3[] = [];
	private dfIdx: number[] = [];
	private dfEdge: Vec3[] = []; // cross(centers[i], centers[i+1])
	private dfOrient = 1;
	private dfMargin = 0;
	// tangent frame of the cached dual face (for mean-value coordinates) + scratch
	private dfG: Vec3 = [0, 0, 0];
	private dfE1: Vec3 = [0, 0, 0];
	private dfE2: Vec3 = [0, 0, 0];
	private readonly dfSx = new Float64Array(10);
	private readonly dfSy = new Float64Array(10);
	private readonly dfR = new Float64Array(10);

	constructor(data: IconGridData, ranges: DimensionRange[] | null = null) {
		this.n = data.iconRoot;
		this.k = data.iconBisections;
		this.cellsPerRoot = 4 ** this.k;
		this.cellsPerFace = this.n * this.n * this.cellsPerRoot;
		this.nx = 20 * this.cellsPerFace;
		this.ny = data.ny;
		this.nxStart = ranges ? ranges[1].start : 0;

		if (data.nx !== this.nx) {
			throw new Error(
				`IconGrid R${this.n}B${this.k} has ${this.nx} cells, but domain declares nx=${data.nx}`
			);
		}

		const tableB64 = ICON_WARP_TABLES[this.n];
		this.warp = tableB64 ? decodeWarpTable(tableB64) : null;
		this.captureLevel = this.warp ? Math.min(this.k, this.warp.baseLevel) : this.k;

		// Icosahedron with pole vertices; upper ring at lon 36°+72°i, lower ring
		// offset by a further 36° (DWD orientation, see header).
		const np = latLonToVec(90, 0);
		const sp = latLonToVec(-90, 0);
		const upper: Vec3[] = [];
		const lower: Vec3[] = [];
		for (let i = 0; i < 5; i++) {
			upper.push(latLonToVec(UPPER_LAT, 36 + i * 72));
			lower.push(latLonToVec(-UPPER_LAT, 72 + i * 72));
		}

		this.faces = [];
		for (let i = 0; i < 5; i++) {
			// north cap, apex at the pole
			this.faces.push(this.makeFace(np, upper[i], upper[(i + 1) % 5]));
		}
		for (let i = 0; i < 5; i++) {
			// downward belt triangles, apex at the lower ring
			this.faces.push(this.makeFace(lower[i], upper[(i + 1) % 5], upper[i]));
		}
		for (let i = 0; i < 5; i++) {
			// upward belt triangles, apex at the upper ring
			this.faces.push(this.makeFace(upper[(i + 1) % 5], lower[i], lower[(i + 1) % 5]));
		}
		for (let i = 0; i < 5; i++) {
			// south cap, apex at the pole
			this.faces.push(this.makeFace(sp, lower[(i + 1) % 5], lower[i]));
		}

		if (this.warp) {
			const w = this.warp;
			this.hotThreshold = w.patchRadius / 2 ** (w.tableK - w.baseLevel);
			// rebuild the base-lattice vertex positions (identical to the descent
			// vertices) and unpack the quantized tangent offsets to 3D once
			this.baseWarp = new Float64Array(20 * w.perFaceBase * 3);
			for (let f = 0; f < 20; f++) {
				let lattice = this.rootLattices[f];
				for (let level = 0; level < w.baseLevel; level++) lattice = refineLattice(lattice);
				for (let j = 0; j <= w.baseRes; j++) {
					for (let i = 0; i <= w.baseRes - j; i++) {
						const li = f * w.perFaceBase + j * (w.baseRes + 1) - (j * (j - 1)) / 2 + i;
						const g = lattice[i][j];
						const [e, nn] = tangentFrame(g);
						const we = w.base[li * 2] * w.quantChord;
						const wn = w.base[li * 2 + 1] * w.quantChord;
						this.baseWarp[li * 3] = we * e[0] + wn * nn[0];
						this.baseWarp[li * 3 + 1] = we * e[1] + wn * nn[1];
						this.baseWarp[li * 3 + 2] = we * e[2] + wn * nn[2];
					}
				}
			}
		}
		this.rootLattices.length = 0; // only needed for the warp decode
	}

	// Build one face: the root lattice L(i,j) (i toward v1, j toward v2) with
	// edge points at equal great-circle arcs and interior points at normalized
	// planar barycenters (for n ≤ 3 the only interior point is the exact
	// symmetric face centre), then the n² root triangles in rootLocal order.
	private makeFace(a: Vec3, b: Vec3, c: Vec3): Face {
		const n = this.n;
		const s = 2 ** this.k; // lattice units per root edge
		const lattice: Vec3[][] = [];
		for (let i = 0; i <= n; i++) {
			lattice.push([]);
			for (let j = 0; j <= n - i; j++) {
				let p: Vec3;
				if (i === 0 && j === 0) {
					p = a;
				} else if (j === 0) {
					p = slerp(a, b, i / n);
				} else if (i === 0) {
					p = slerp(a, c, j / n);
				} else if (i + j === n) {
					p = slerp(b, c, j / n);
				} else {
					const wa = 1 - (i + j) / n;
					p = normalize([
						wa * a[0] + (i / n) * b[0] + (j / n) * c[0],
						wa * a[1] + (i / n) * b[1] + (j / n) * c[1],
						wa * a[2] + (i / n) * b[2] + (j / n) * c[2]
					]);
				}
				lattice[i].push(p);
			}
		}
		this.rootLattices.push(lattice);

		const makeRoot = (v0: Vec3, v1: Vec3, v2: Vec3, coords: RootTriangle['c']): RootTriangle => {
			const inward = (u: Vec3, v: Vec3, ref: Vec3): Vec3 => {
				let nrm = normalize(cross(u, v));
				if (dot(nrm, ref) < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]];
				return nrm;
			};
			return {
				v0,
				v1,
				v2,
				n01: inward(v0, v1, v2),
				n12: inward(v1, v2, v0),
				n20: inward(v2, v0, v1),
				c: coords
			};
		};

		// rootLocal ordering: upright T(i,j) = r² + 2j with r = i+j; inverted
		// T'(i,j) fills (i+j+1)² + 2j + 1 of the next row
		const roots: RootTriangle[] = new Array(n * n);
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n - i; j++) {
				roots[(i + j) * (i + j) + 2 * j] = makeRoot(
					lattice[i][j],
					lattice[i + 1][j],
					lattice[i][j + 1],
					[i * s, j * s, (i + 1) * s, j * s, i * s, (j + 1) * s]
				);
			}
		}
		for (let i = 0; i < n - 1; i++) {
			for (let j = 0; j < n - 1 - i; j++) {
				roots[(i + j + 1) * (i + j + 1) + 2 * j + 1] = makeRoot(
					lattice[i + 1][j + 1],
					lattice[i][j + 1],
					lattice[i + 1][j],
					[(i + 1) * s, (j + 1) * s, i * s, (j + 1) * s, (i + 1) * s, j * s]
				);
			}
		}

		return {
			center: [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]],
			roots
		};
	}

	getBounds(): Bounds {
		return [-180, -90, 180, 90];
	}

	getCenter(): { lng: number; lat: number } {
		return { lng: 0, lat: 0 };
	}

	getCoveringRanges(
		_south: number,
		_west: number,
		_north: number,
		_east: number
	): DimensionRange[] {
		// A lat/lon box maps to scattered subtrees of the cell hierarchy, which
		// a single contiguous range cannot express — read the full grid for now
		// (~11.8 MB for R3B07). Subtree-based covering is a possible follow-up.
		return [
			{ start: 0, end: this.ny },
			{ start: 0, end: this.nx }
		];
	}

	/**
	 * Locates the GEOMETRIC cell containing a unit vector, returning the leaf
	 * triangle and warp-lookup context.
	 */
	private locateVec(p: Vec3): LeafContext & { index: number } {
		let face = 0;
		let rootLocal = 0;
		// same-root fast path: when a seed root (from the previous query) still
		// contains p, skip the 20-face + n²-root global search entirely.
		if (
			this.seedValid &&
			(() => {
				const rt = this.faces[this.seedFace].roots[this.seedRoot];
				return dot(p, rt.n01) >= -1e-9 && dot(p, rt.n12) >= -1e-9 && dot(p, rt.n20) >= -1e-9;
			})()
		) {
			face = this.seedFace;
			rootLocal = this.seedRoot;
		} else {
			let best = -Infinity;
			for (let f = 0; f < 20; f++) {
				const d = dot(p, this.faces[f].center);
				if (d > best) {
					best = d;
					face = f;
				}
			}
			// root triangle: the one whose three edge-side tests are most inside
			// (max-min score also absorbs float noise on shared edges)
			const roots = this.faces[face].roots;
			let bestScore = -Infinity;
			for (let r = 0; r < roots.length; r++) {
				const root = roots[r];
				const score = Math.min(dot(p, root.n01), dot(p, root.n12), dot(p, root.n20));
				if (score > bestScore) {
					bestScore = score;
					rootLocal = r;
				}
			}
		}
		this.seedFace = face;
		this.seedRoot = rootLocal;
		this.seedValid = true;
		const root = this.faces[face].roots[rootLocal];
		let v0 = root.v0;
		let v1 = root.v1;
		let v2 = root.v2;
		let c: LeafContext['c'] = [...root.c];
		let lbV: LeafContext['lbV'] = [v0, v1, v2];
		let lbC: LeafContext['lbC'] = c;
		if (this.captureLevel === 0) {
			lbV = [v0, v1, v2];
			lbC = [...c];
		}

		// bisection descent: one great-circle-side test per child; a point on a
		// boundary circle goes to the first corner child tested (deterministic)
		let index = (face * this.n * this.n + rootLocal) * this.cellsPerRoot;
		let scale = this.cellsPerRoot;
		for (let level = 0; level < this.k; level++) {
			scale /= 4;
			const m01 = mid(v0, v1);
			const m12 = mid(v1, v2);
			const m20 = mid(v2, v0);
			const x01 = (c[0] + c[2]) / 2;
			const y01 = (c[1] + c[3]) / 2;
			const x12 = (c[2] + c[4]) / 2;
			const y12 = (c[3] + c[5]) / 2;
			const x20 = (c[4] + c[0]) / 2;
			const y20 = (c[5] + c[1]) / 2;
			// p on the v0 side of the great circle through m01, m20?
			const c0 = cross(m01, m20);
			if (dot(p, c0) * dot(v0, c0) >= 0) {
				v1 = m01;
				v2 = m20;
				c = [c[0], c[1], x01, y01, x20, y20];
				// digit 0 adds nothing
			} else {
				const c1 = cross(m12, m01);
				if (dot(p, c1) * dot(v1, c1) >= 0) {
					v0 = m01;
					v2 = m12;
					c = [x01, y01, c[2], c[3], x12, y12];
					index += scale;
				} else {
					const c2 = cross(m20, m12);
					if (dot(p, c2) * dot(v2, c2) >= 0) {
						v0 = m20;
						v1 = m12;
						c = [x20, y20, x12, y12, c[4], c[5]];
						index += 3 * scale;
					} else {
						// centre child
						const nv0 = m12;
						const nv1 = m20;
						const nv2 = m01;
						v0 = nv0;
						v1 = nv1;
						v2 = nv2;
						c = [x12, y12, x20, y20, x01, y01];
						index += 2 * scale;
					}
				}
			}
			if (level + 1 === this.captureLevel) {
				lbV = [v0, v1, v2];
				lbC = [...c];
			}
		}

		return { index, face, v0, v1, v2, c, lbV, lbC };
	}

	// leaf triangle of a cell (by global index), following the digit descent
	private leafTriangle(globalIndex: number): LeafContext {
		const face = Math.floor(globalIndex / this.cellsPerFace);
		const inFace = globalIndex - face * this.cellsPerFace;
		const rootLocal = Math.floor(inFace / this.cellsPerRoot);
		let rest = inFace - rootLocal * this.cellsPerRoot;

		const root = this.faces[face].roots[rootLocal];
		let v0 = root.v0;
		let v1 = root.v1;
		let v2 = root.v2;
		let c: LeafContext['c'] = [...root.c];
		let lbV: LeafContext['lbV'] = [v0, v1, v2];
		let lbC: LeafContext['lbC'] = c;
		if (this.captureLevel === 0) {
			lbV = [v0, v1, v2];
			lbC = [...c];
		}

		let scale = this.cellsPerRoot;
		for (let level = 0; level < this.k; level++) {
			scale /= 4;
			const digit = Math.floor(rest / scale);
			rest -= digit * scale;
			const m01 = mid(v0, v1);
			const m12 = mid(v1, v2);
			const m20 = mid(v2, v0);
			const x01 = (c[0] + c[2]) / 2;
			const y01 = (c[1] + c[3]) / 2;
			const x12 = (c[2] + c[4]) / 2;
			const y12 = (c[3] + c[5]) / 2;
			const x20 = (c[4] + c[0]) / 2;
			const y20 = (c[5] + c[1]) / 2;
			if (digit === 0) {
				v1 = m01;
				v2 = m20;
				c = [c[0], c[1], x01, y01, x20, y20];
			} else if (digit === 1) {
				v0 = m01;
				v2 = m12;
				c = [x01, y01, c[2], c[3], x12, y12];
			} else if (digit === 2) {
				v0 = m12;
				v1 = m20;
				v2 = m01;
				c = [x12, y12, x20, y20, x01, y01];
			} else {
				v0 = m20;
				v1 = m12;
				c = [x20, y20, x12, y12, c[4], c[5]];
			}
			if (level + 1 === this.captureLevel) {
				lbV = [v0, v1, v2];
				lbC = [...c];
			}
		}
		return { face, v0, v1, v2, c, lbV, lbC };
	}

	// dequantize one PATCH warp sample on demand (patch hits are rare); the
	// tangent frame lives at the sample's geometric position
	private dequantPatch(idx: number, geo: Vec3): Vec3 {
		const w = this.warp!;
		const q = w.quantChord;
		const [e, nn] = tangentFrame(geo);
		const we = w.patches[idx * 2] * q;
		const wn = w.patches[idx * 2 + 1] * q;
		return [we * e[0] + wn * nn[0], we * e[1] + wn * nn[1], we * e[2] + wn * nn[2]];
	}

	// base-lattice sample index for a vertex at grid-lattice coords (x, y)
	private baseSampleIndex(face: number, x: number, y: number): number {
		const w = this.warp!;
		const g = 2 ** (this.k - w.baseLevel); // grid lattice units per base step
		const bi = x / g;
		const bj = y / g;
		return face * w.perFaceBase + bj * (w.baseRes + 1) - (bj * (bj - 1)) / 2 + bi;
	}

	// warp field of the base lattice at a position, interpolated over the
	// captured coarse triangle (pre-decoded samples: three reads + barycentric)
	private baseWarpAt(pos: Vec3, ctx: Pick<LeafContext, 'face' | 'lbV' | 'lbC'>): Vec3 {
		const bw = this.baseWarp!;
		const i0 = this.baseSampleIndex(ctx.face, ctx.lbC[0], ctx.lbC[1]) * 3;
		const i1 = this.baseSampleIndex(ctx.face, ctx.lbC[2], ctx.lbC[3]) * 3;
		const i2 = this.baseSampleIndex(ctx.face, ctx.lbC[4], ctx.lbC[5]) * 3;
		const b0 = dot(pos, cross(ctx.lbV[1], ctx.lbV[2]));
		const b1 = dot(pos, cross(ctx.lbV[2], ctx.lbV[0]));
		const b2 = dot(pos, cross(ctx.lbV[0], ctx.lbV[1]));
		const bs = b0 + b1 + b2;
		return [
			(b0 * bw[i0] + b1 * bw[i1] + b2 * bw[i2]) / bs,
			(b0 * bw[i0 + 1] + b1 * bw[i1 + 1] + b2 * bw[i2 + 1]) / bs,
			(b0 * bw[i0 + 2] + b1 * bw[i1 + 2] + b2 * bw[i2 + 2]) / bs
		];
	}

	// is this context near a pentagon point (face corner)? Cold contexts can
	// never touch a patched vertex, so they may use the pure base-lattice warp
	private isHot(ctx: Pick<LeafContext, 'lbC'>): boolean {
		if (this.hotThreshold <= 0) return false;
		const w = this.warp!;
		const g = 2 ** (this.k - w.baseLevel);
		const NB = w.baseRes;
		for (let s = 0; s < 3; s++) {
			const bx = ctx.lbC[s * 2] / g;
			const by = ctx.lbC[s * 2 + 1] / g;
			if (Math.min(bx + by, NB - bx, NB - by) <= this.hotThreshold) return true;
		}
		return false;
	}

	/**
	 * Canonical warp of a subdivision vertex at integer lattice coords (x, y):
	 * exact patch value near the pentagon points, otherwise base-lattice
	 * interpolation. Only used on the (rare) hot path — cold cells use
	 * baseWarpAt directly, which is identical there.
	 */
	private vertexWarp(ctx: LeafContext, x: number, y: number, pos: Vec3): Vec3 {
		const w = this.warp!;
		// grid lattice -> table lattice units (2^(tableK - k), may be fractional
		// for grids finer than the table)
		const f = 2 ** (w.tableK - this.k);
		const xt = x * f;
		const yt = y * f;
		if (Number.isInteger(xt) && Number.isInteger(yt)) {
			const P = w.patchRadius;
			const NT = w.tableRes;
			const a = NT - xt - yt;
			let corner = -1;
			let u = 0;
			let v = 0;
			if (xt + yt <= P) {
				corner = 0;
				u = xt;
				v = yt;
			} else if (NT - xt <= P) {
				corner = 1;
				u = yt;
				v = a;
			} else if (NT - yt <= P) {
				corner = 2;
				u = a;
				v = xt;
			}
			if (corner >= 0) {
				const pi = (ctx.face * 3 + corner) * w.perPatch + v * (P + 1) - (v * (v - 1)) / 2 + u;
				return this.dequantPatch(pi, pos);
			}
		}
		return this.baseWarpAt(pos, ctx);
	}

	// accurate warp field at an arbitrary point (hot path): interpolate the
	// three canonical vertex warps of the containing geometric leaf triangle
	private warpAt(p: Vec3, ctx: LeafContext): Vec3 {
		const w0 = this.vertexWarp(ctx, ctx.c[0], ctx.c[1], ctx.v0);
		const w1 = this.vertexWarp(ctx, ctx.c[2], ctx.c[3], ctx.v1);
		const w2 = this.vertexWarp(ctx, ctx.c[4], ctx.c[5], ctx.v2);
		const b0 = dot(p, cross(ctx.v1, ctx.v2));
		const b1 = dot(p, cross(ctx.v2, ctx.v0));
		const b2 = dot(p, cross(ctx.v0, ctx.v1));
		const bs = b0 + b1 + b2;
		return [
			(b0 * w0[0] + b1 * w1[0] + b2 * w2[0]) / bs,
			(b0 * w0[1] + b1 * w1[1] + b2 * w2[1]) / bs,
			(b0 * w0[2] + b1 * w1[2] + b2 * w2[2]) / bs
		];
	}

	// face + root + captureLevel descent only — enough context for the base
	// warp, at a fraction of a full leaf descent
	private partialLocate(p: Vec3): Pick<LeafContext, 'face' | 'lbV' | 'lbC'> {
		let face = 0;
		let best = -Infinity;
		for (let f = 0; f < 20; f++) {
			const d = dot(p, this.faces[f].center);
			if (d > best) {
				best = d;
				face = f;
			}
		}
		const roots = this.faces[face].roots;
		let rootLocal = 0;
		let bestScore = -Infinity;
		for (let r = 0; r < roots.length; r++) {
			const root = roots[r];
			const score = Math.min(dot(p, root.n01), dot(p, root.n12), dot(p, root.n20));
			if (score > bestScore) {
				bestScore = score;
				rootLocal = r;
			}
		}
		const root = roots[rootLocal];
		let v0 = root.v0;
		let v1 = root.v1;
		let v2 = root.v2;
		let c: LeafContext['c'] = [...root.c];
		for (let level = 0; level < this.captureLevel; level++) {
			const m01 = mid(v0, v1);
			const m12 = mid(v1, v2);
			const m20 = mid(v2, v0);
			const x01 = (c[0] + c[2]) / 2;
			const y01 = (c[1] + c[3]) / 2;
			const x12 = (c[2] + c[4]) / 2;
			const y12 = (c[3] + c[5]) / 2;
			const x20 = (c[4] + c[0]) / 2;
			const y20 = (c[5] + c[1]) / 2;
			const c0 = cross(m01, m20);
			if (dot(p, c0) * dot(v0, c0) >= 0) {
				v1 = m01;
				v2 = m20;
				c = [c[0], c[1], x01, y01, x20, y20];
			} else {
				const c1 = cross(m12, m01);
				if (dot(p, c1) * dot(v1, c1) >= 0) {
					v0 = m01;
					v2 = m12;
					c = [x01, y01, c[2], c[3], x12, y12];
				} else {
					const c2 = cross(m20, m12);
					if (dot(p, c2) * dot(v2, c2) >= 0) {
						v0 = m20;
						v1 = m12;
						c = [x20, y20, x12, y12, c[4], c[5]];
					} else {
						v0 = m12;
						v1 = m20;
						v2 = m01;
						c = [x12, y12, x20, y20, x01, y01];
					}
				}
			}
		}
		return { face, lbV: [v0, v1, v2], lbC: c };
	}

	// map a true (warped-grid) position back into the geometric grid. Cold
	// regions: one fixed-point step with the base warp (a cheap partial
	// descent). Near the pentagon points the warp field has patch detail and
	// larger gradients, so use the accurate leaf-level warp and two steps.
	private inversePoint(p: Vec3): Vec3 {
		// coarse-context fast path: reuse the cached cold partialLocate result when
		// p is strictly inside its coarse triangle (partialLocate is a
		// deterministic function of p, so this is exact).
		if (this.icCacheValid) {
			const o = this.icOrient;
			if (
				dot(p, this.icN12) * o > this.icMargin &&
				dot(p, this.icN20) * o > this.icMargin &&
				dot(p, this.icN01) * o > this.icMargin
			) {
				const w = this.baseWarpAt(p, this.icCtx!);
				return normalize([p[0] - w[0], p[1] - w[1], p[2] - w[2]]);
			}
		}
		const ctx5 = this.partialLocate(p);
		if (!this.isHot(ctx5)) {
			// cache this cold coarse triangle for subsequent nearby queries
			const [l0, l1, l2] = ctx5.lbV;
			this.icN12 = cross(l1, l2);
			this.icN20 = cross(l2, l0);
			this.icN01 = cross(l0, l1);
			const det = dot(l0, this.icN12);
			this.icOrient = det >= 0 ? 1 : -1;
			this.icMargin = Math.abs(det) * 1e-3;
			this.icCtx = ctx5;
			this.icCacheValid = true;
			const w = this.baseWarpAt(p, ctx5);
			return normalize([p[0] - w[0], p[1] - w[1], p[2] - w[2]]);
		}
		this.icCacheValid = false; // hot region — don't serve stale cold context
		const w0 = this.warpAt(p, this.locateVec(p));
		const p1 = normalize([p[0] - w0[0], p[1] - w0[1], p[2] - w0[2]]);
		const w1 = this.warpAt(p1, this.locateVec(p1));
		return normalize([p[0] - w1[0], p[1] - w1[1], p[2] - w1[2]]);
	}

	/**
	 * Locates the cell containing a coordinate (inverse-warping the point when
	 * a warp table is active, so lookups match the true DWD cells).
	 */
	findCell(lat: number, lon: number): number {
		let p = latLonToVec(lat, lon);
		if (this.warp) p = this.inversePoint(p);
		const o = this.fcOrient;
		if (
			this.fcCacheValid &&
			dot(p, this.fcN12) * o > this.fcMargin &&
			dot(p, this.fcN20) * o > this.fcMargin &&
			dot(p, this.fcN01) * o > this.fcMargin
		) {
			return this.fcIndex;
		}
		const cell = this.locateVec(p);
		this.fcN12 = cross(cell.v1, cell.v2);
		this.fcN20 = cross(cell.v2, cell.v0);
		this.fcN01 = cross(cell.v0, cell.v1);
		const det = dot(cell.v0, this.fcN12);
		this.fcOrient = det >= 0 ? 1 : -1;
		this.fcMargin = Math.abs(det) * 1e-3;
		this.fcIndex = cell.index - this.nxStart;
		this.fcCacheValid = true;
		return this.fcIndex;
	}

	// the three (warped) triangle corners of a leaf context, as unit vectors
	private warpTriangleCtx(ctx: LeafContext): [Vec3, Vec3, Vec3] {
		const verts: Vec3[] = [ctx.v0, ctx.v1, ctx.v2];
		const hot = this.isHot(ctx);
		const out: Vec3[] = [];
		for (let s = 0; s < 3; s++) {
			const w = hot
				? this.vertexWarp(ctx, ctx.c[s * 2], ctx.c[s * 2 + 1], verts[s])
				: this.baseWarpAt(verts[s], ctx);
			out.push(normalize([verts[s][0] + w[0], verts[s][1] + w[1], verts[s][2] + w[2]]));
		}
		return out as [Vec3, Vec3, Vec3];
	}

	// the three (warped) triangle corners of a cell, as unit vectors
	private warpedTriangle(globalIndex: number): [Vec3, Vec3, Vec3] {
		const ctx = this.leafTriangle(globalIndex);
		if (!this.warp) return [ctx.v0, ctx.v1, ctx.v2];
		return this.warpTriangleCtx(ctx);
	}

	/**
	 * The three corners of a cell's triangle. With a warp table these are the
	 * true (operational-grid) vertex positions to table accuracy.
	 */
	cellVertices(index: number): { lat: number; lon: number }[] {
		return this.warpedTriangle(index + this.nxStart).map((v) => ({
			lat: radiansToDegrees(Math.asin(v[2])),
			lon: radiansToDegrees(Math.atan2(v[1], v[0]))
		}));
	}

	// spherical circumcenter of a (warped) triangle, as a unit vector
	private static circumcenter(a: Vec3, b: Vec3, c: Vec3): Vec3 {
		const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
		const e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
		let cc = cross(e1, e2);
		if (dot(cc, a) < 0) cc = [-cc[0], -cc[1], -cc[2]];
		return normalize(cc);
	}

	// spherical circumcenter of a cell's (warped) triangle, as a unit vector
	private cellCenterVec(globalIndex: number): Vec3 {
		const [a, b, c] = this.warpedTriangle(globalIndex);
		return IconGrid.circumcenter(a, b, c);
	}

	/**
	 * Geographic centre of a cell: the spherical circumcenter of the (warped)
	 * triangle — ICON's mass-point definition (clat/clon in the grid files are
	 * the circumcenters of the spring-optimized triangles).
	 */
	cellCoordinates(index: number): { lat: number; lon: number } {
		const cc = this.cellCenterVec(index + this.nxStart);
		return {
			lat: radiansToDegrees(Math.asin(cc[2])),
			lon: radiansToDegrees(Math.atan2(cc[1], cc[0]))
		};
	}

	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number {
		return this.getInterpolatedValue(values, lat, lon, 'linear');
	}

	// true centre (circumcenter of the warped triangle) of a located leaf
	private centerFromCtx(ctx: LeafContext): Vec3 {
		if (!this.warp) return IconGrid.circumcenter(ctx.v0, ctx.v1, ctx.v2);
		const [a, b, d] = this.warpTriangleCtx(ctx);
		return IconGrid.circumcenter(a, b, d);
	}

	// index of the array entry nearest (max dot) to t
	private static nearestVert(v0: Vec3, v1: Vec3, v2: Vec3, t: Vec3): number {
		const d0 = dot(v0, t),
			d1 = dot(v1, t),
			d2 = dot(v2, t);
		return d0 >= d1 ? (d0 >= d2 ? 0 : 2) : d1 >= d2 ? 1 : 2;
	}

	// Walk the ring of cells sharing the primal vertex V (5 at a pentagon, else
	// 6), collecting their indices and true centres in rotational order. Each
	// step reflects the current centre across the shared edge at V and re-locates
	// (seeded, so cheap). Robust across roots/faces/pentagons; caps the loop.
	private vertexRing(cell: LeafContext & { index: number }, V: Vec3): void {
		this.dfCount = 0;
		let cur: LeafContext & { index: number } = cell;
		const vi = IconGrid.nearestVert(cur.v0, cur.v1, cur.v2, V);
		const verts0 = [cur.v0, cur.v1, cur.v2];
		let shared = verts0[(vi + 1) % 3]; // vertex on the edge we cross next
		for (let step = 0; step < 8; step++) {
			this.dfIdx[this.dfCount] = cur.index - this.nxStart;
			this.dfCenters[this.dfCount] = this.centerFromCtx(cur);
			this.dfCount++;
			const nrm = normalize(cross(V, shared));
			const cx = cur.v0[0] + cur.v1[0] + cur.v2[0];
			const cy = cur.v0[1] + cur.v1[1] + cur.v2[1];
			const cz = cur.v0[2] + cur.v1[2] + cur.v2[2];
			const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
			const gcx = cx / cl,
				gcy = cy / cl,
				gcz = cz / cl;
			const d2 = 2 * (gcx * nrm[0] + gcy * nrm[1] + gcz * nrm[2]);
			const refl: Vec3 = [gcx - d2 * nrm[0], gcy - d2 * nrm[1], gcz - d2 * nrm[2]];
			const next = this.locateVec(refl);
			if (next.index === cell.index) break;
			const nvi = IconGrid.nearestVert(next.v0, next.v1, next.v2, V);
			const nsi = IconGrid.nearestVert(next.v0, next.v1, next.v2, shared);
			shared = [next.v0, next.v1, next.v2][3 - nvi - nsi];
			cur = next;
		}
	}

	// Mean-value-coordinate interpolation of the (true) point p over the cached
	// dual-face ring. Unlike a fan triangulation this is smooth (C∞) inside the
	// polygon — no gradient kinks along fan diagonals, so contours stay smooth —
	// while still reproducing linear fields and cell values exactly. Weights use
	// the trig-free tangent form tan(α/2) = (rᵢrⱼ − sᵢ·sⱼ)/(sᵢ×sⱼ) on the
	// orthographic projection into the face's tangent plane. NaN-aware.
	private interpDual(values: Float32Array, p: Vec3): number {
		const m = this.dfCount;
		const C = this.dfCenters;
		const I = this.dfIdx;
		const e1 = this.dfE1;
		const e2 = this.dfE2;
		const px = dot(p, e1);
		const py = dot(p, e2);
		const Sx = this.dfSx;
		const Sy = this.dfSy;
		const R = this.dfR;
		for (let i = 0; i < m; i++) {
			const sx = dot(C[i], e1) - px;
			const sy = dot(C[i], e2) - py;
			const r = Math.sqrt(sx * sx + sy * sy);
			if (r < 1e-12) return roundWithPrecision(values[I[i]]); // p at a centre
			Sx[i] = sx;
			Sy[i] = sy;
			R[i] = r;
		}
		let s = 0;
		let wsum = 0;
		let missing = 0;
		for (let i = 0; i < m; i++) {
			const j = (i + 1) % m;
			const h = (i + m - 1) % m;
			// tan(half-angle) on each side of vertex i
			const crossPrev = Sx[h] * Sy[i] - Sy[h] * Sx[i];
			const crossNext = Sx[i] * Sy[j] - Sy[i] * Sx[j];
			const tPrev =
				crossPrev !== 0 ? (R[h] * R[i] - (Sx[h] * Sx[i] + Sy[h] * Sy[i])) / crossPrev : 0;
			const tNext =
				crossNext !== 0 ? (R[i] * R[j] - (Sx[i] * Sx[j] + Sy[i] * Sy[j])) / crossNext : 0;
			const w = (tPrev + tNext) / R[i];
			const v = values[I[i]];
			if (isFinite(v)) {
				s += w * v;
				wsum += w;
			} else {
				missing += w;
			}
		}
		// weights share a sign (CW/CCW winding); ignore missing neighbours unless
		// they carry more weight than the finite ones
		if (wsum === 0 || Math.abs(missing) > Math.abs(wsum)) return NaN;
		return roundWithPrecision(s / wsum);
	}

	// C0 linear interpolation of cell-centre data via the dual mesh (fixes the
	// triangular faceting of the 3-neighbour blend). Reuses the cached ring for
	// any query strictly inside its polygon (skips the inverse-warp entirely).
	private getDualValue(values: Float32Array, lat: number, lon: number): number {
		const p = latLonToVec(lat, lon);
		if (this.dfCacheValid) {
			const o = this.dfOrient;
			let inside = true;
			for (let i = 0; i < this.dfCount; i++) {
				if (dot(p, this.dfEdge[i]) * o <= this.dfMargin) {
					inside = false;
					break;
				}
			}
			if (inside) return this.interpDual(values, p);
		}
		const pGeo = this.warp ? this.inversePoint(p) : p;
		const cell = this.locateVec(pGeo);
		// try the ring of each of the cell's vertices (nearest first) until one
		// whose polygon actually contains p — that is the dual face p lives in
		const order = [IconGrid.nearestVert(cell.v0, cell.v1, cell.v2, pGeo)];
		order.push((order[0] + 1) % 3, (order[0] + 2) % 3);
		for (let a = 0; a < 3; a++) {
			const V = [cell.v0, cell.v1, cell.v2][order[a]];
			this.vertexRing(cell, V);
			const m = this.dfCount;
			// polygon edge normals + orientation
			for (let i = 0; i < m; i++)
				this.dfEdge[i] = cross(this.dfCenters[i], this.dfCenters[(i + 1) % m]);
			const cenx = this.dfCenters.slice(0, m).reduce((s, c) => s + c[0], 0);
			const ceny = this.dfCenters.slice(0, m).reduce((s, c) => s + c[1], 0);
			const cenz = this.dfCenters.slice(0, m).reduce((s, c) => s + c[2], 0);
			const cen: Vec3 = [cenx, ceny, cenz];
			const det0 = dot(cen, this.dfEdge[0]);
			this.dfOrient = det0 >= 0 ? 1 : -1;
			const o = this.dfOrient;
			let inside = true;
			for (let i = 0; i < m; i++) {
				if (dot(p, this.dfEdge[i]) * o <= 0) {
					inside = false;
					break;
				}
			}
			if (inside || a === 2) {
				// strict-inside (margin 0): a query with all edge tests > 0 is
				// inside this dual polygon, which is exactly its dual face; boundary
				// points fall through to a re-locate. Maximizes the cache hit rate.
				this.dfMargin = 0;
				// tangent frame at the face centroid, for mean-value coordinates
				this.dfG = normalize(cen);
				const [fe1, fe2] = tangentFrame(this.dfG);
				this.dfE1 = fe1;
				this.dfE2 = fe2;
				this.dfCacheValid = true;
				return this.interpDual(values, p);
			}
		}
		return values[cell.index - this.nxStart];
	}

	getNearestNeighborValue(values: Float32Array, lat: number, lon: number): number {
		return values[this.findCell(lat, lon)];
	}

	getInterpolatedValue(
		values: Float32Array,
		lat: number,
		lon: number,
		method: InterpolationMethod
	): number {
		switch (method) {
			case 'nearest':
				return this.getNearestNeighborValue(values, lat, lon);
			// C0 linear interpolation over the dual mesh (ring of cell centres).
			// Cubic/monotone have no meaningful extension on this stencil.
			case 'cubic':
			case 'monotone':
			case 'linear':
				return this.getDualValue(values, lat, lon);
			default: {
				// Exhaustiveness check; also throws at runtime for untyped callers.
				const _exhaustive: never = method;
				throw new Error(`Unknown interpolation method: ${_exhaustive}`);
			}
		}
	}

	// value at a primal vertex for smooth (Gouraud) rasterization: the mean of the
	// cells around it. Reuses the dual-mesh ring walk; cached by vertex geometry so
	// the ~6 shared cells are only gathered once per vertex per tile.
	private vertexValue(
		values: Float32Array,
		cell: LeafContext & { index: number },
		V: Vec3
	): number {
		// (re)use the dual-face cache machinery via getDualValue's helpers: build
		// the ring around V and average its finite cell values
		this.vertexRing(cell, V);
		let s = 0;
		let cnt = 0;
		for (let i = 0; i < this.dfCount; i++) {
			const v = values[this.dfIdx[i]];
			if (isFinite(v)) {
				s += v;
				cnt++;
			}
		}
		return cnt ? s / cnt : NaN;
	}

	/**
	 * Rasterise this grid's native (warped) triangles directly into a mercator
	 * tile, forward (cell → pixels) instead of sampling per pixel. Returns a
	 * tileSize² value buffer (NaN where no cell covers the pixel). The cells that
	 * touch the tile are found by descending the icosahedral hierarchy and pruning
	 * subtrees whose projected bounding box misses the tile — no per-pixel descent,
	 * no lat/lon re-gridding, exact triangular boundaries. 'nearest' flat-fills each
	 * triangle with its cell value; 'linear' Gouraud-interpolates the three
	 * primal-vertex values (dual-mesh means).
	 */
	renderTile(
		values: Float32Array,
		x: number,
		y: number,
		z: number,
		tileSize: number,
		method: InterpolationMethod
	): Float32Array {
		const out = new Float32Array(tileSize * tileSize).fill(NaN);
		const smooth = method !== 'nearest';
		const worldPx = 2 ** z * tileSize;
		const VS = this.n * 2 ** this.k + 1; // face lattice edge size, for vertex keys
		const vcache = new Map<number, number>(); // primal-vertex value memo (smooth)
		// tile lat/lon box (mercator is monotonic in lat & lon, so a lat/lon
		// overlap test is equivalent to a pixel-box test but immune to projection
		// distortion). A little padding covers the warp + straddling cells.
		const tLonL = tile2lon(x, z);
		let tLonR = tile2lon(x + 1, z);
		if (tLonR <= tLonL) tLonR += 360;
		const tLatT = tile2lat(y, z);
		const tLatB = tile2lat(y + 1, z);
		const pad = ((tLonR - tLonL) * 0.05 + 0.05) * (Math.PI / 180); // radians, small
		// project a unit vector to tile-local pixel coords, unwrapping longitude
		// so antimeridian-straddling triangles stay contiguous near this tile
		const project = (v: Vec3): [number, number] => {
			const lat = radiansToDegrees(Math.asin(Math.max(-0.9999, Math.min(0.9999, v[2]))));
			const lon = radiansToDegrees(Math.atan2(v[1], v[0]));
			let px = (lon2tile(lon, z) - x) * tileSize;
			px -= Math.round((px - tileSize / 2) / worldPx) * worldPx;
			const py = (lat2tile(lat, z) - y) * tileSize;
			return [px, py];
		};
		const fill = (
			a: [number, number],
			b: [number, number],
			c: [number, number],
			va: number,
			vb: number,
			vc: number
		): void => {
			const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
			if (d === 0) return;
			const inv = 1 / d;
			const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
			const maxX = Math.min(tileSize - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
			const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
			const maxY = Math.min(tileSize - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
			for (let py = minY; py <= maxY; py++) {
				const sy = py + 0.5;
				const row = py * tileSize;
				for (let px = minX; px <= maxX; px++) {
					const sx = px + 0.5;
					const l0 = ((b[1] - c[1]) * (sx - c[0]) + (c[0] - b[0]) * (sy - c[1])) * inv;
					const l1 = ((c[1] - a[1]) * (sx - c[0]) + (a[0] - c[0]) * (sy - c[1])) * inv;
					const l2 = 1 - l0 - l1;
					if (l0 >= 0 && l1 >= 0 && l2 >= 0)
						out[row + px] = smooth ? l0 * va + l1 * vb + l2 * vc : va;
				}
			}
		};

		// recursive descent over the bisection tree carrying the leaf context
		const rasterize = (
			v0: Vec3,
			v1: Vec3,
			v2: Vec3,
			c: LeafContext['c'],
			index: number,
			level: number,
			face: number,
			lbV: LeafContext['lbV'],
			lbC: LeafContext['lbC']
		): void => {
			// prune with a spherical cap (centroid + circumradius) that contains the
			// whole triangle, bulges included — in lat/lon, so it's exact w.r.t. the
			// monotone mercator tile box and needs no projection guessing.
			const cx = v0[0] + v1[0] + v2[0];
			const cy = v0[1] + v1[1] + v2[1];
			const cz = v0[2] + v1[2] + v2[2];
			const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
			const ux = cx / cl;
			const uy = cy / cl;
			const uz = cz / cl;
			const cosR = Math.min(
				ux * v0[0] + uy * v0[1] + uz * v0[2],
				ux * v1[0] + uy * v1[1] + uz * v1[2],
				ux * v2[0] + uy * v2[1] + uz * v2[2]
			);
			const r = Math.acos(Math.max(-1, Math.min(1, cosR))) + pad; // cap angular radius
			const cLat = Math.asin(Math.max(-1, Math.min(1, uz)));
			if ((cLat - r) * (180 / Math.PI) > tLatT || (cLat + r) * (180 / Math.PI) < tLatB) return;
			const cLon = Math.atan2(uy, ux) * (180 / Math.PI);
			const lonR = (r / Math.max(Math.cos(cLat), 1e-3)) * (180 / Math.PI); // lon half-extent (deg)
			// longitude overlap with wrap: bring the cap's lon window near the tile
			let loMin = cLon - lonR;
			let loMax = cLon + lonR;
			if (loMax - loMin >= 360) {
				// spans all longitudes (near a pole) — keep
			} else {
				loMin -= Math.round((0.5 * (loMin + loMax) - 0.5 * (tLonL + tLonR)) / 360) * 360;
				loMax = loMin + 2 * lonR;
				if (loMax < tLonL || loMin > tLonR) return;
			}

			if (level === this.k) {
				const ctx: LeafContext = { face, v0, v1, v2, c, lbV, lbC };
				const [w0, w1, w2] = this.warp ? this.warpTriangleCtx(ctx) : [v0, v1, v2];
				if (smooth) {
					const cell = { ...ctx, index };
					const verts = [v0, v1, v2];
					const vv = (s: number): number => {
						// cache the primal-vertex mean by lattice id (shared by ~6 cells)
						const key = ((face * VS + c[2 * s]) * VS + c[2 * s + 1]) | 0;
						let val = vcache.get(key);
						if (val === undefined) {
							val = this.vertexValue(values, cell, verts[s]);
							vcache.set(key, val);
						}
						return val;
					};
					fill(project(w0), project(w1), project(w2), vv(0), vv(1), vv(2));
				} else {
					const v = values[index - this.nxStart];
					fill(project(w0), project(w1), project(w2), v, v, v);
				}
				return;
			}

			const m01 = mid(v0, v1);
			const m12 = mid(v1, v2);
			const m20 = mid(v2, v0);
			const x01 = (c[0] + c[2]) / 2;
			const y01 = (c[1] + c[3]) / 2;
			const x12 = (c[2] + c[4]) / 2;
			const y12 = (c[3] + c[5]) / 2;
			const x20 = (c[4] + c[0]) / 2;
			const y20 = (c[5] + c[1]) / 2;
			const scale = 4 ** (this.k - 1 - level);
			const capture = level + 1 === this.captureLevel;
			const rec = (a: Vec3, b: Vec3, cc: Vec3, cd: LeafContext['c'], digit: number): void => {
				rasterize(
					a,
					b,
					cc,
					cd,
					index + digit * scale,
					level + 1,
					face,
					capture ? [a, b, cc] : lbV,
					capture ? [...cd] : lbC
				);
			};
			rec(v0, m01, m20, [c[0], c[1], x01, y01, x20, y20], 0);
			rec(m01, v1, m12, [x01, y01, c[2], c[3], x12, y12], 1);
			rec(m12, m20, m01, [x12, y12, x20, y20, x01, y01], 2);
			rec(m20, m12, v2, [x20, y20, x12, y12, c[4], c[5]], 3);
		};

		for (let f = 0; f < 20; f++) {
			for (let rl = 0; rl < this.n * this.n; rl++) {
				const root = this.faces[f].roots[rl];
				const c: LeafContext['c'] = [...root.c];
				rasterize(
					root.v0,
					root.v1,
					root.v2,
					c,
					(f * this.n * this.n + rl) * this.cellsPerRoot,
					0,
					f,
					[root.v0, root.v1, root.v2],
					c
				);
			}
		}
		// close the rare sub-pixel slivers between adjacent triangles: any leftover
		// NaN takes a filled neighbour's value (ICON is global, so every in-tile
		// pixel belongs to some cell — a NaN here is always a seam, not real gap).
		for (let py = 0; py < tileSize; py++) {
			for (let px = 0; px < tileSize; px++) {
				const i = py * tileSize + px;
				if (out[i] === out[i]) continue; // already filled
				let n = px > 0 ? out[i - 1] : NaN;
				if (n !== n) n = px < tileSize - 1 ? out[i + 1] : NaN;
				if (n !== n) n = py > 0 ? out[i - tileSize] : NaN;
				if (n !== n) n = py < tileSize - 1 ? out[i + tileSize] : NaN;
				if (n === n) out[i] = n;
			}
		}
		return out;
	}

	forEachPoint(callback: (point: GridPoint) => void | false, bounds?: Bounds): void {
		for (let index = 0; index < this.nx; index++) {
			const { lat, lon } = this.cellCoordinates(index - this.nxStart);
			if (bounds) {
				if (lat < bounds[1] || lat > bounds[3] || lon < bounds[0] || lon > bounds[2]) continue;
			}
			const result = callback({ index: index - this.nxStart, lat, lon });
			if (result === false) return;
		}
	}
}
