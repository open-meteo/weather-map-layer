import { radiansToDegrees, roundWithPrecision } from '../utils/math';

import { GridInterface, GridPoint } from './interface';

import { Bounds, DimensionRange, IconGridData, InterpolationMethod } from '../types';

// Native ICON icosahedral-triangular grid (analytical, no grid file).
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
// Remaining deviation from the operational grid: DWD optimizes the vertex
// positions with spring dynamics. Relative to this geometric construction
// the true cell centres are displaced by a smooth warp field of roughly
// constant absolute amplitude, dominated by the coarse subdivision levels
// (~9 km mean for the R3 family: 0.53 cell edges at R3B06, 1.05 at R3B07;
// ~16 km / 0.61 edges at R2B06 — largest towards the 12 pentagon points).
// The cell numbering matches exactly; sampled fields are warped by about
// one cell width but stay locally consistent. Modelling the warp (e.g.
// small-circle subdivision or a coarse correction table) is a possible
// follow-up.
//
// Point location descends the same hierarchy: face via arg-max against the
// 20 face centres (exact — the perpendicular bisector plane of two adjacent
// face centres contains their shared edge), root triangle via
// great-circle-side tests, then one sign test per bisection level. All
// boundaries are great circles through the subdivision vertices, so the
// tests are exact for the geometric grid.

type Vec3 = [number, number, number];

interface RootTriangle {
	v0: Vec3;
	v1: Vec3;
	v2: Vec3;
	// unit inward normals of the three edge planes, for containment scoring
	n01: Vec3;
	n12: Vec3;
	n20: Vec3;
}

interface Face {
	// face centroid (unnormalized is fine for the arg-max test)
	center: Vec3;
	// root triangles in rootLocal order, generator vertex order
	roots: RootTriangle[];
}

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

		const makeRoot = (v0: Vec3, v1: Vec3, v2: Vec3): RootTriangle => {
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
				n20: inward(v2, v0, v1)
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
					lattice[i][j + 1]
				);
			}
		}
		for (let i = 0; i < n - 1; i++) {
			for (let j = 0; j < n - 1 - i; j++) {
				roots[(i + j + 1) * (i + j + 1) + 2 * j + 1] = makeRoot(
					lattice[i + 1][j + 1],
					lattice[i][j + 1],
					lattice[i + 1][j]
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
	 * Locates the cell containing a unit vector and returns its global index
	 * together with the leaf triangle vertices (needed for interpolation).
	 */
	private locateVec(p: Vec3): { index: number; v0: Vec3; v1: Vec3; v2: Vec3 } {
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

		// bisection descent: one great-circle-side test per child; a point on a
		// boundary circle goes to the first corner child tested (deterministic)
		let index = (face * this.n * this.n + rootLocal) * this.cellsPerRoot;
		let scale = this.cellsPerRoot;
		for (let level = 0; level < this.k; level++) {
			scale /= 4;
			const m01 = mid(v0, v1);
			const m12 = mid(v1, v2);
			const m20 = mid(v2, v0);
			// p on the v0 side of the great circle through m01, m20?
			const c0 = cross(m01, m20);
			if (dot(p, c0) * dot(v0, c0) >= 0) {
				v1 = m01;
				v2 = m20;
				// digit 0 adds nothing
			} else {
				const c1 = cross(m12, m01);
				if (dot(p, c1) * dot(v1, c1) >= 0) {
					v0 = m01;
					v2 = m12;
					index += scale;
				} else {
					const c2 = cross(m20, m12);
					if (dot(p, c2) * dot(v2, c2) >= 0) {
						v0 = m20;
						v1 = m12;
						index += 3 * scale;
					} else {
						// centre child
						v0 = m12;
						v1 = m20;
						v2 = m01;
						index += 2 * scale;
					}
				}
			}
		}

		return { index, v0, v1, v2 };
	}

	/**
	 * Analytically locates the cell containing a coordinate.
	 */
	findCell(lat: number, lon: number): number {
		return this.locateVec(latLonToVec(lat, lon)).index - this.nxStart;
	}

	// leaf triangle vertices of a cell, following the digit descent
	private leafTriangle(globalIndex: number): { v0: Vec3; v1: Vec3; v2: Vec3 } {
		const face = Math.floor(globalIndex / this.cellsPerFace);
		const inFace = globalIndex - face * this.cellsPerFace;
		const rootLocal = Math.floor(inFace / this.cellsPerRoot);
		let rest = inFace - rootLocal * this.cellsPerRoot;

		const root = this.faces[face].roots[rootLocal];
		let v0 = root.v0;
		let v1 = root.v1;
		let v2 = root.v2;

		let scale = this.cellsPerRoot;
		for (let level = 0; level < this.k; level++) {
			scale /= 4;
			const digit = Math.floor(rest / scale);
			rest -= digit * scale;
			const m01 = mid(v0, v1);
			const m12 = mid(v1, v2);
			const m20 = mid(v2, v0);
			if (digit === 0) {
				v1 = m01;
				v2 = m20;
			} else if (digit === 1) {
				v0 = m01;
				v2 = m12;
			} else if (digit === 2) {
				v0 = m12;
				v1 = m20;
				v2 = m01;
			} else {
				v0 = m20;
				v1 = m12;
			}
		}
		return { v0, v1, v2 };
	}

	/**
	 * Geographic centre of a cell (normalized centroid of the leaf triangle —
	 * the geometric geodesic-grid position; the operational ICON grid shifts
	 * these slightly via spring dynamics, see header).
	 */
	cellCoordinates(index: number): { lat: number; lon: number } {
		const { v0, v1, v2 } = this.leafTriangle(index + this.nxStart);
		const px = v0[0] + v1[0] + v2[0];
		const py = v0[1] + v1[1] + v2[1];
		const pz = v0[2] + v1[2] + v2[2];
		const norm = Math.hypot(px, py, pz);

		return {
			lat: radiansToDegrees(Math.asin(pz / norm)),
			lon: radiansToDegrees(Math.atan2(py, px))
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
	private getBarycentricValue(values: Float32Array, lat: number, lon: number): number {
		const p = latLonToVec(lat, lon);
		const cell = this.locateVec(p);

		// cell centre and the three edge-neighbour centres (reflections of the
		// centre across the great-circle edge planes — exact up to the small
		// shape distortion between adjacent cells)
		const c: Vec3 = normalize([
			cell.v0[0] + cell.v1[0] + cell.v2[0],
			cell.v0[1] + cell.v1[1] + cell.v2[1],
			cell.v0[2] + cell.v1[2] + cell.v2[2]
		]);
		const reflect = (a: Vec3, b: Vec3): Vec3 => {
			const nrm = normalize(cross(a, b));
			const d = 2 * dot(c, nrm);
			return [c[0] - d * nrm[0], c[1] - d * nrm[1], c[2] - d * nrm[2]];
		};
		const neighbors = [
			reflect(cell.v0, cell.v1),
			reflect(cell.v1, cell.v2),
			reflect(cell.v2, cell.v0)
		];

		const v = values[cell.index - this.nxStart];
		const nv = neighbors.map((q) => values[this.locateVec(q).index - this.nxStart]);

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
