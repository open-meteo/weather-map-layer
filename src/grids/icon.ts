import { radiansToDegrees, roundWithPrecision } from '../utils/math';

import { ICON_WARP_TABLES } from './icon-warp-tables';
import { GridInterface, GridPoint } from './interface';

import { Bounds, DimensionRange, IconGridData, InterpolationMethod } from '../types';

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
// is inverse-warped first (two fixed-point iterations, verified exact for
// all cell centres).

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
	const l = Math.hypot(v[0], v[1], v[2]);
	return [v[0] / l, v[1] / l, v[2] / l];
};

// normalized (spherical) edge midpoint
const mid = (u: Vec3, v: Vec3): Vec3 => normalize([u[0] + v[0], u[1] + v[1], u[2] + v[2]]);

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

	// dequantize one warp sample; the tangent frame lives at the sample's
	// geometric position
	private dequant(arr: Int16Array, idx: number, geo: Vec3): Vec3 {
		const q = this.warp!.quantChord;
		const [e, nn] = tangentFrame(geo);
		const we = arr[idx * 2] * q;
		const wn = arr[idx * 2 + 1] * q;
		return [we * e[0] + wn * nn[0], we * e[1] + wn * nn[1], we * e[2] + wn * nn[2]];
	}

	/**
	 * Canonical warp of a subdivision vertex at integer lattice coords (x, y):
	 * exact patch value near the pentagon points, otherwise gnomonic-barycentric
	 * interpolation of the base lattice over the captured coarse triangle.
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
				return this.dequant(w.patches, pi, pos);
			}
		}
		// base lattice: samples at the captured triangle's corners
		const g = 2 ** (this.k - w.baseLevel); // grid lattice units per base step
		const wx: Vec3[] = [];
		for (let s = 0; s < 3; s++) {
			const bi = ctx.lbC[s * 2] / g;
			const bj = ctx.lbC[s * 2 + 1] / g;
			const li = ctx.face * w.perFaceBase + bj * (w.baseRes + 1) - (bj * (bj - 1)) / 2 + bi;
			wx.push(this.dequant(w.base, li, ctx.lbV[s]));
		}
		const b0 = dot(pos, cross(ctx.lbV[1], ctx.lbV[2]));
		const b1 = dot(pos, cross(ctx.lbV[2], ctx.lbV[0]));
		const b2 = dot(pos, cross(ctx.lbV[0], ctx.lbV[1]));
		const bs = b0 + b1 + b2;
		return [
			(b0 * wx[0][0] + b1 * wx[1][0] + b2 * wx[2][0]) / bs,
			(b0 * wx[0][1] + b1 * wx[1][1] + b2 * wx[2][1]) / bs,
			(b0 * wx[0][2] + b1 * wx[1][2] + b2 * wx[2][2]) / bs
		];
	}

	// warp field at an arbitrary point: interpolate the three canonical vertex
	// warps of the containing geometric leaf triangle
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

	// map a true (warped-grid) position back into the geometric grid: two
	// fixed-point iterations of p' = p − W(p'), enough for exact cell lookups
	private inversePoint(p: Vec3): Vec3 {
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
		return this.locateVec(p).index - this.nxStart;
	}

	// the three (warped) triangle corners of a cell, as unit vectors
	private warpedTriangle(globalIndex: number): [Vec3, Vec3, Vec3] {
		const ctx = this.leafTriangle(globalIndex);
		if (!this.warp) return [ctx.v0, ctx.v1, ctx.v2];
		const out: Vec3[] = [];
		const verts: Vec3[] = [ctx.v0, ctx.v1, ctx.v2];
		for (let s = 0; s < 3; s++) {
			const w = this.vertexWarp(ctx, ctx.c[s * 2], ctx.c[s * 2 + 1], verts[s]);
			out.push(normalize([verts[s][0] + w[0], verts[s][1] + w[1], verts[s][2] + w[2]]));
		}
		return out as [Vec3, Vec3, Vec3];
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

	// spherical circumcenter of a cell's (warped) triangle, as a unit vector
	private cellCenterVec(globalIndex: number): Vec3 {
		const [a, b, c] = this.warpedTriangle(globalIndex);
		const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
		const e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
		let cc = cross(e1, e2);
		if (dot(cc, a) < 0) cc = [-cc[0], -cc[1], -cc[2]];
		return normalize(cc);
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
			// The 4-cell stencil (containing cell + 3 edge neighbours) has no
			// meaningful cubic extension; both fall back to the barycentric blend.
			case 'cubic':
			case 'monotone':
			case 'linear':
				return this.getBarycentricValue(values, lat, lon);
			default: {
				// Exhaustiveness check; also throws at runtime for untyped callers.
				const _exhaustive: never = method;
				throw new Error(`Unknown interpolation method: ${_exhaustive}`);
			}
		}
	}

	// Bilinear-equivalent sampling on the triangular grid: blend the containing
	// cell with its three edge neighbours. The neighbour centres form a triangle
	// around the cell centre; the sample point falls into one of the three
	// sectors (centre + two neighbours) and is interpolated with projective
	// (gnomonic) barycentric weights, which reproduces linear fields exactly.
	// Corner regions of the leaf triangle poke slightly outside the neighbour
	// triangle; negative weights are clamped there (mild flattening right at
	// cell vertices, where a 6-cell vertex ring would be needed instead).
	// Neighbour INDICES are found in the geometric space of the inverse-warped
	// sample point; the weights use the true (warped) cell centres, where the
	// data values live, so cell centres reproduce their value exactly.
	private getBarycentricValue(values: Float32Array, lat: number, lon: number): number {
		const p = latLonToVec(lat, lon);
		const pGeo = this.warp ? this.inversePoint(p) : p;
		const cell = this.locateVec(pGeo);

		// edge-neighbour indices: reflect the geometric centre across the
		// great-circle edge planes (lands well inside each neighbour)
		const cGeo: Vec3 = normalize([
			cell.v0[0] + cell.v1[0] + cell.v2[0],
			cell.v0[1] + cell.v1[1] + cell.v2[1],
			cell.v0[2] + cell.v1[2] + cell.v2[2]
		]);
		const reflect = (a: Vec3, b: Vec3): Vec3 => {
			const nrm = normalize(cross(a, b));
			const d = 2 * dot(cGeo, nrm);
			return [cGeo[0] - d * nrm[0], cGeo[1] - d * nrm[1], cGeo[2] - d * nrm[2]];
		};
		const neighborIdx = [
			this.locateVec(reflect(cell.v0, cell.v1)).index,
			this.locateVec(reflect(cell.v1, cell.v2)).index,
			this.locateVec(reflect(cell.v2, cell.v0)).index
		];

		// interpolation nodes: the true cell centres
		const c = this.cellCenterVec(cell.index);
		const neighbors = neighborIdx.map((i) => this.cellCenterVec(i));
		const v = values[cell.index - this.nxStart];
		const nv = neighborIdx.map((i) => values[i - this.nxStart]);

		// projective barycentric weights of p in the spherical triangle (c, a, b):
		// ratios of scalar triple products (equivalent to planar barycentrics in
		// the gnomonic projection, hence linear-exact)
		const det = (a: Vec3, b: Vec3, q: Vec3): number => dot(q, cross(a, b));
		let bestWeights: [number, number, number] | null = null;
		let bestSector = 0;
		let bestMin = -Infinity;
		for (let s = 0; s < 3; s++) {
			const a = neighbors[s];
			const b = neighbors[(s + 1) % 3];
			const w0 = det(a, b, p);
			const wa = det(b, c, p);
			const wb = det(c, a, p);
			const sum = w0 + wa + wb;
			if (sum === 0) continue;
			const weights: [number, number, number] = [w0 / sum, wa / sum, wb / sum];
			const min = Math.min(weights[0], weights[1], weights[2]);
			if (min > bestMin) {
				bestMin = min;
				bestWeights = weights;
				bestSector = s;
			}
		}
		if (!bestWeights) return v;

		// clamp corner-region extrapolation and renormalize
		const w0 = Math.max(bestWeights[0], 0);
		const wa = Math.max(bestWeights[1], 0);
		const wb = Math.max(bestWeights[2], 0);
		const va = nv[bestSector];
		const vb = nv[(bestSector + 1) % 3];

		// NaN awareness in the spirit of bilinearNaNAware: ignore missing
		// neighbours if the remaining (finite) weight still dominates
		let sum = 0;
		let weightSum = 0;
		if (isFinite(v)) {
			sum += v * w0;
			weightSum += w0;
		} else if (w0 > 0) {
			return NaN;
		}
		if (isFinite(va)) {
			sum += va * wa;
			weightSum += wa;
		}
		if (isFinite(vb)) {
			sum += vb * wb;
			weightSum += wb;
		}
		if (weightSum < 0.5) return NaN;
		return roundWithPrecision(sum / weightSum);
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
