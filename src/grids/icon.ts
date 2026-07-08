import { radiansToDegrees } from '../utils/math';

import { GridInterface, GridPoint } from './interface';

import { Bounds, DimensionRange, IconGridData } from '../types';

// Native ICON icosahedral-triangular grid (analytical, no grid file).
//
// The ICON R{n}B{k} grid starts from a regular icosahedron oriented with one
// vertex on each pole. Each of the 20 spherical faces is divided into n²
// root triangles (every edge split into n equal parts), and each root
// triangle is then bisected k times (each level splits a triangle into 4:
// three corner children and one inverted centre child). The global 13 km
// grid is R3B07: 20 · 3² · 4⁷ = 2,949,120 cells.
//
// Canonical cell ordering (this is the layout the .om data must follow):
//   index = (face · n² + rootLocal) · 4^k + d₁·4^(k-1) + … + d_k
// with faces ordered north cap (0-4), downward belt (5-9), upward belt
// (10-14), south cap (15-19); root triangles row-major from the face apex
// (see rootLocal below); and bisection digits d ∈ {0: corner A, 1: corner B,
// 2: corner C, 3: centre}, most significant first.
//
// All point location happens in gnomonic barycentric coordinates, which is
// exact: the gnomonic projection (radial, from the sphere centre onto the
// face plane) maps every normalized subdivision vertex back onto its planar
// lattice position and every great-circle edge onto a straight line, so
// planar barycentric containment coincides with spherical containment. Each
// bisection level is a constant-time barycentric transform — no vector math
// in the descent.
//
// Deviation from the operational ICON grid: DWD optimizes the vertex
// positions with spring dynamics, which shifts cells by a small fraction of
// their size relative to these geometric positions, and the operational cell
// numbering may differ from this canonical hierarchical order. Data must be
// remapped into this layout once on the producer side (or the orderings
// verified equivalent against the official grid file).

type Vec3 = [number, number, number];

interface Face {
	// vertices, apex first
	a: Vec3;
	b: Vec3;
	c: Vec3;
	// face centroid (unnormalized is fine for the arg-max test)
	center: Vec3;
	// rows of the inverse vertex matrix scaled by 1/det: barycentric
	// coordinates of p are the dot products with these, normalized to sum 1
	invA: Vec3;
	invB: Vec3;
	invC: Vec3;
}

const cross = (u: Vec3, v: Vec3): Vec3 => [
	u[1] * v[2] - u[2] * v[1],
	u[2] * v[0] - u[0] * v[2],
	u[0] * v[1] - u[1] * v[0]
];

const dot = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

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

		// Icosahedron with pole vertices; upper ring at lon 0°+72°k, lower ring
		// offset by 36° (canonical orientation, see header).
		const np = latLonToVec(90, 0);
		const sp = latLonToVec(-90, 0);
		const upper: Vec3[] = [];
		const lower: Vec3[] = [];
		for (let i = 0; i < 5; i++) {
			upper.push(latLonToVec(UPPER_LAT, i * 72));
			lower.push(latLonToVec(-UPPER_LAT, 36 + i * 72));
		}

		const makeFace = (a: Vec3, b: Vec3, c: Vec3): Face => {
			const bxc = cross(b, c);
			const det = dot(a, bxc);
			const scale = (v: Vec3): Vec3 => [v[0] / det, v[1] / det, v[2] / det];
			return {
				a,
				b,
				c,
				center: [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]],
				invA: scale(bxc),
				invB: scale(cross(c, a)),
				invC: scale(cross(a, b))
			};
		};

		this.faces = [];
		for (let i = 0; i < 5; i++) {
			// north cap, apex at the pole
			this.faces.push(makeFace(np, upper[i], upper[(i + 1) % 5]));
		}
		for (let i = 0; i < 5; i++) {
			// downward belt triangles, apex at the lower ring
			this.faces.push(makeFace(lower[i], upper[i], upper[(i + 1) % 5]));
		}
		for (let i = 0; i < 5; i++) {
			// upward belt triangles, apex at the upper ring
			this.faces.push(makeFace(upper[(i + 1) % 5], lower[i], lower[(i + 1) % 5]));
		}
		for (let i = 0; i < 5; i++) {
			// south cap, apex at the pole
			this.faces.push(makeFace(sp, lower[i], lower[(i + 1) % 5]));
		}
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
	 * Analytically locates the cell containing a coordinate:
	 * icosahedron face (arg-max against the 20 face centres — exact, since the
	 * perpendicular bisector of two adjacent face centres is their shared edge
	 * plane) → root triangle via the barycentric lattice → k bisection digits,
	 * each a constant-time barycentric transform.
	 */
	findCell(lat: number, lon: number): number {
		const p = latLonToVec(lat, lon);

		let face = 0;
		let best = -Infinity;
		for (let f = 0; f < 20; f++) {
			const d = dot(p, this.faces[f].center);
			if (d > best) {
				best = d;
				face = f;
			}
		}
		const fc = this.faces[face];

		// gnomonic barycentric coordinates of p in this face
		const ra = dot(p, fc.invA);
		const rb = dot(p, fc.invB);
		const rc = dot(p, fc.invC);
		const sum = ra + rb + rc;
		const b = rb / sum;
		const c = rc / sum;

		// root triangle in the n-division lattice; clamp against float noise on
		// face edges
		const n = this.n;
		const x = b * n;
		const y = c * n;
		let i = Math.min(Math.max(Math.floor(x), 0), n - 1);
		let j = Math.min(Math.max(Math.floor(y), 0), n - 1);
		if (i + j > n - 1) {
			// numerically past the hypotenuse row: pull back onto the face
			const over = i + j - (n - 1);
			if (i >= j) i -= over;
			else j -= over;
		}
		const fx = x - i;
		const fy = y - j;

		// local barycentrics inside the root triangle (see rootLocal ordering:
		// upright T(i,j) = r² + 2j with r = i+j; inverted T'(i,j) fills r²+2j+1
		// of the next row)
		let rootLocal: number;
		let a2: number;
		let b2: number;
		let c2: number;
		if (fx + fy <= 1 || i + j === n - 1) {
			rootLocal = (i + j) * (i + j) + 2 * j;
			b2 = fx;
			c2 = fy;
			a2 = 1 - fx - fy;
		} else {
			// inverted triangle with vertices L(i+1,j), L(i,j+1), L(i+1,j+1)
			rootLocal = (i + j + 1) * (i + j + 1) + 2 * j + 1;
			a2 = 1 - fy;
			b2 = 1 - fx;
			c2 = fx + fy - 1;
		}

		// bisection descent: each level picks the corner whose barycentric
		// exceeds ½ (or the centre child) and rescales the coordinates
		let index = (face * n * n + rootLocal) * this.cellsPerRoot;
		let scale = this.cellsPerRoot;
		for (let level = 0; level < this.k; level++) {
			scale /= 4;
			if (a2 > 0.5) {
				a2 = 2 * a2 - 1;
				b2 = 2 * b2;
				c2 = 2 * c2;
				// digit 0 adds nothing
			} else if (b2 > 0.5) {
				a2 = 2 * a2;
				b2 = 2 * b2 - 1;
				c2 = 2 * c2;
				index += scale;
			} else if (c2 > 0.5) {
				a2 = 2 * a2;
				b2 = 2 * b2;
				c2 = 2 * c2 - 1;
				index += 2 * scale;
			} else {
				// centre child (MAB, MBC, MCA)
				const na = 1 - 2 * c2;
				const nb = 1 - 2 * a2;
				const nc = 1 - 2 * b2;
				a2 = na;
				b2 = nb;
				c2 = nc;
				index += 3 * scale;
			}
		}

		return index - this.nxStart;
	}

	/**
	 * Geographic centre of a cell (normalized planar centroid of the leaf
	 * triangle — the geometric geodesic-grid position; the operational ICON
	 * grid shifts these slightly via spring dynamics).
	 */
	cellCoordinates(index: number): { lat: number; lon: number } {
		const globalIndex = index + this.nxStart;
		const n = this.n;
		const face = Math.floor(globalIndex / this.cellsPerFace);
		const inFace = globalIndex - face * this.cellsPerFace;
		const rootLocal = Math.floor(inFace / this.cellsPerRoot);
		let rest = inFace - rootLocal * this.cellsPerRoot;

		// invert rootLocal → lattice triangle (see findCell)
		const r = Math.floor(Math.sqrt(rootLocal));
		const rem = rootLocal - r * r;
		let v0: Vec3;
		let v1: Vec3;
		let v2: Vec3;
		if (rem % 2 === 0) {
			const j = rem / 2;
			const i = r - j;
			v0 = [1 - (i + j) / n, i / n, j / n];
			v1 = [1 - (i + 1 + j) / n, (i + 1) / n, j / n];
			v2 = [1 - (i + j + 1) / n, i / n, (j + 1) / n];
		} else {
			const j = (rem - 1) / 2;
			const i = r - 1 - j;
			v0 = [1 - (i + 1 + j) / n, (i + 1) / n, j / n];
			v1 = [1 - (i + j + 1) / n, i / n, (j + 1) / n];
			v2 = [1 - (i + j + 2) / n, (i + 1) / n, (j + 1) / n];
		}

		// descend the bisection digits, shrinking the vertex triple (vertices
		// are barycentric triples w.r.t. the face corners)
		const mid = (u: Vec3, v: Vec3): Vec3 => [
			(u[0] + v[0]) / 2,
			(u[1] + v[1]) / 2,
			(u[2] + v[2]) / 2
		];
		let scale = this.cellsPerRoot;
		for (let level = 0; level < this.k; level++) {
			scale /= 4;
			const digit = Math.floor(rest / scale);
			rest -= digit * scale;
			if (digit === 0) {
				v1 = mid(v0, v1);
				v2 = mid(v0, v2);
			} else if (digit === 1) {
				v0 = mid(v0, v1);
				v2 = mid(v1, v2);
			} else if (digit === 2) {
				v0 = mid(v0, v2);
				v1 = mid(v1, v2);
			} else {
				const m01 = mid(v0, v1);
				const m12 = mid(v1, v2);
				const m20 = mid(v2, v0);
				v0 = m01;
				v1 = m12;
				v2 = m20;
			}
		}

		const a = (v0[0] + v1[0] + v2[0]) / 3;
		const b = (v0[1] + v1[1] + v2[1]) / 3;
		const c = (v0[2] + v1[2] + v2[2]) / 3;
		const fc = this.faces[face];
		const px = a * fc.a[0] + b * fc.b[0] + c * fc.c[0];
		const py = a * fc.a[1] + b * fc.b[1] + c * fc.c[1];
		const pz = a * fc.a[2] + b * fc.b[2] + c * fc.c[2];
		const norm = Math.sqrt(px * px + py * py + pz * pz);

		return {
			lat: radiansToDegrees(Math.asin(pz / norm)),
			lon: radiansToDegrees(Math.atan2(py, px))
		};
	}

	// Piecewise-constant sampling: the value of the cell containing the
	// coordinate. This renders the true native triangles; blending with the
	// three edge-neighbour cells (analytical neighbour finding in the bisection
	// hierarchy) is a possible next iteration.
	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number {
		return values[this.findCell(lat, lon)];
	}

	getNearestNeighborValue(values: Float32Array, lat: number, lon: number): number {
		return values[this.findCell(lat, lon)];
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
