import { radiansToDegrees, roundWithPrecision } from '../../utils/math';
import { GridInterface, GridPoint } from '../interface';

import { ICON_ANALYTICAL_MODEL as M } from './icon-analytical-model';

import { Bounds, DimensionRange, IconGridData, InterpolationMethod } from '../../types';

// Purely-analytical ICON grid — the alternative to the embedded warp table
// (grids/icon.ts). Instead of storing the DWD spring-dynamics displacement in an
// 810 KB table, the true cell centres/vertices are reconstructed from ~33 KB of
// polynomial coefficients (icon-analytical-model.ts): the warp is a smooth map
// on each face's barycentric simplex, fit per root triangle (Bernstein, with a
// parity split for the circumcenter oscillation) plus a ρ^(1/3) cone model at
// the 12 pentagon points. Accuracy vs the operational grid: ~0.75 km mean /
// ~1.7 km max for centres, ~1.8 km for vertices (the table reaches 0.5 km). It
// is a bit slower per call than the table (polynomial eval + pentagon cone) but
// drops the big blob — see icon-native-test/gen-model.mts for the derivation.
// Only the R3 family (n = 3) has a model; other divisions should use IconGrid.

type Vec3 = [number, number, number];

const dot = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const cross = (u: Vec3, v: Vec3): Vec3 => [
	u[1] * v[2] - u[2] * v[1],
	u[2] * v[0] - u[0] * v[2],
	u[0] * v[1] - u[1] * v[0]
];
const normalize = (v: Vec3): Vec3 => {
	const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
	return [v[0] / l, v[1] / l, v[2] / l];
};
const mid = (u: Vec3, v: Vec3): Vec3 => normalize([u[0] + v[0], u[1] + v[1], u[2] + v[2]]);
const slerp = (a: Vec3, b: Vec3, t: number): Vec3 => {
	const om = Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
	if (om < 1e-12) return a;
	const sa = Math.sin((1 - t) * om) / Math.sin(om);
	const sb = Math.sin(t * om) / Math.sin(om);
	return [sa * a[0] + sb * b[0], sa * a[1] + sb * b[1], sa * a[2] + sb * b[2]];
};
const latLonToVec = (latDeg: number, lonDeg: number): Vec3 => {
	const lat = (latDeg * Math.PI) / 180;
	const lon = (lonDeg * Math.PI) / 180;
	const cosLat = Math.cos(lat);
	return [cosLat * Math.cos(lon), cosLat * Math.sin(lon), Math.sin(lat)];
};
const vecToLatLon = (v: Vec3) => ({
	lat: radiansToDegrees(Math.asin(Math.max(-1, Math.min(1, v[2])))),
	lon: radiansToDegrees(Math.atan2(v[1], v[0]))
});
const tangentFrame = (g: Vec3): [Vec3, Vec3] => {
	const horiz = Math.hypot(g[0], g[1]);
	if (horiz < 1e-9)
		return [
			[0, 1, 0],
			[g[2] > 0 ? -1 : 1, 0, 0]
		];
	const e: Vec3 = [-g[1] / horiz, g[0] / horiz, 0];
	return [e, normalize(cross(g, e))];
};
// const circumcenter = (a: Vec3, b: Vec3, c: Vec3): Vec3 => {
// 	const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
// 	const e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
// 	let cc = cross(e1, e2);
// 	if (dot(cc, a) < 0) cc = [-cc[0], -cc[1], -cc[2]];
// 	return normalize(cc);
// };

interface Root {
	v0: Vec3;
	v1: Vec3;
	v2: Vec3;
	n01: Vec3;
	n12: Vec3;
	n20: Vec3;
}
interface Leaf {
	index: number;
	v0: Vec3;
	v1: Vec3;
	v2: Vec3;
}

const PENT: Record<number, number> = { 0: 0, 4: 1, 8: 2 };
const EMPTY: number[] = [];

export class IconGridAnalytical implements GridInterface {
	private readonly ny: number;
	private readonly nx: number;
	private readonly nxStart: number;
	private readonly n: number;
	private readonly k: number;
	private readonly cpr: number; // cells per root = 4^k
	private readonly cpf: number; // cells per face
	private readonly S: number; // lattice units per root edge = 2^k
	private readonly faces: { center: Vec3; roots: Root[] }[] = [];

	// analytical model
	private readonly DEG = M.DEG;
	private readonly L1 = 1;
	private readonly CI = M.CI;
	private readonly CJ = M.CJ;
	private readonly NB = M.NB;
	private readonly NC = M.NC;
	private readonly bTerms: [number, number, number, number][] = [];

	// dual-mesh interpolation cache (see IconGrid.getDualValue)
	private dfValid = false;
	private dfCount = 0;
	private dfCenters: Vec3[] = [];
	private dfIdx: number[] = [];
	private dfEdge: Vec3[] = [];
	private dfOrient = 1;
	private dfG: Vec3 = [0, 0, 0];
	private dfE1: Vec3 = [0, 0, 0];
	private dfE2: Vec3 = [0, 0, 0];
	private readonly dfSx = new Float64Array(10);
	private readonly dfSy = new Float64Array(10);
	private readonly dfR = new Float64Array(10);
	private seedFace = 0;
	private seedRoot = 0;
	private seedValid = false;

	constructor(data: IconGridData, ranges: DimensionRange[] | null = null) {
		this.n = data.iconRoot;
		this.k = data.iconBisections;
		if (this.n !== M.n)
			throw new Error(`IconGridAnalytical only has a model for n=${M.n} (got n=${this.n})`);
		this.cpr = 4 ** this.k;
		this.cpf = this.n * this.n * this.cpr;
		this.S = 2 ** this.k;
		this.nx = 20 * this.cpf;
		this.ny = data.ny;
		this.nxStart = ranges ? ranges[1].start : 0;

		const fact = [1];
		for (let i = 1; i <= 10; i++) fact.push(fact[i - 1] * i);
		for (let i = 0; i <= this.DEG; i++)
			for (let j = 0; j <= this.DEG - i; j++) {
				const kk = this.DEG - i - j;
				this.bTerms.push([i, j, kk, fact[this.DEG] / (fact[i] * fact[j] * fact[kk])]);
			}

		// icosahedron with pole vertices (identical orientation to IconGrid)
		const upperLat = radiansToDegrees(Math.atan(0.5));
		const np = latLonToVec(90, 0);
		const sp = latLonToVec(-90, 0);
		const up: Vec3[] = [];
		const lo: Vec3[] = [];
		for (let i = 0; i < 5; i++) {
			up.push(latLonToVec(upperLat, 36 + i * 72));
			lo.push(latLonToVec(-upperLat, 72 + i * 72));
		}
		const corners: [Vec3, Vec3, Vec3][] = [];
		for (let i = 0; i < 5; i++) corners.push([np, up[i], up[(i + 1) % 5]]);
		for (let i = 0; i < 5; i++) corners.push([lo[i], up[(i + 1) % 5], up[i]]);
		for (let i = 0; i < 5; i++) corners.push([up[(i + 1) % 5], lo[i], lo[(i + 1) % 5]]);
		for (let i = 0; i < 5; i++) corners.push([sp, lo[(i + 1) % 5], lo[i]]);
		for (const [a, b, c] of corners) this.faces.push(this.makeFace(a, b, c));
	}

	private makeFace(a: Vec3, b: Vec3, c: Vec3): { center: Vec3; roots: Root[] } {
		const n = this.n;
		const lat: Vec3[][] = [];
		for (let i = 0; i <= n; i++) {
			lat.push([]);
			for (let j = 0; j <= n - i; j++) {
				let p: Vec3;
				if (i === 0 && j === 0) p = a;
				else if (j === 0) p = slerp(a, b, i / n);
				else if (i === 0) p = slerp(a, c, j / n);
				else if (i + j === n) p = slerp(b, c, j / n);
				else {
					const wa = 1 - (i + j) / n;
					p = normalize([
						wa * a[0] + (i / n) * b[0] + (j / n) * c[0],
						wa * a[1] + (i / n) * b[1] + (j / n) * c[1],
						wa * a[2] + (i / n) * b[2] + (j / n) * c[2]
					]);
				}
				lat[i].push(p);
			}
		}
		const inward = (u: Vec3, v: Vec3, ref: Vec3): Vec3 => {
			let nrm = normalize(cross(u, v));
			if (dot(nrm, ref) < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]];
			return nrm;
		};
		const mk = (v0: Vec3, v1: Vec3, v2: Vec3): Root => ({
			v0,
			v1,
			v2,
			n01: inward(v0, v1, v2),
			n12: inward(v1, v2, v0),
			n20: inward(v2, v0, v1)
		});
		const roots: Root[] = new Array(n * n);
		for (let i = 0; i < n; i++)
			for (let j = 0; j < n - i; j++)
				roots[(i + j) * (i + j) + 2 * j] = mk(lat[i][j], lat[i + 1][j], lat[i][j + 1]);
		for (let i = 0; i < n - 1; i++)
			for (let j = 0; j < n - 1 - i; j++)
				roots[(i + j + 1) * (i + j + 1) + 2 * j + 1] = mk(
					lat[i + 1][j + 1],
					lat[i][j + 1],
					lat[i + 1][j]
				);
		return { center: [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]], roots };
	}

	// ---- analytical warp model evaluation
	private bEval(a: number, b: number, c: number): number[] {
		const pa = [1, a, a * a, a * a * a, a * a * a * a];
		const pb = [1, b, b * b, b * b * b, b * b * b * b];
		const pc = [1, c, c * c, c * c * c, c * c * c * c];
		return this.bTerms.map(([i, j, kk, co]) => co * pa[i] * pb[j] * pc[kk]);
	}
	private coneEval(cLb: number, cLc: number): number[] {
		const rho = cLb + cLc;
		const mu = Math.cbrt(rho);
		const psi = rho > 1e-12 ? (cLb - cLc) / rho : 0;
		const out: number[] = [];
		let mp = 1;
		for (let i = 0; i < this.CI; i++) {
			let pp = 1;
			const jm = Math.min(i, this.CJ - 1);
			for (let j = 0; j <= jm; j++) {
				out.push(mp * pp);
				pp *= psi;
			}
			mp *= mu;
		}
		return out;
	}
	// displacement (Δa, Δb) in root barycentric — corner roots use the cone
	// coeffs (coneA/coneB), the rest the Bernstein coeffs (ncA/ncB)
	private field(
		rl: number,
		La: number,
		Lb: number,
		Lc: number,
		ncA: number[],
		ncB: number[],
		coneA: number[],
		coneB: number[]
	): [number, number] {
		if (rl in PENT) {
			const pc = PENT[rl];
			const L = [La, Lb, Lc];
			const phi = this.coneEval(L[(pc + 1) % 3], L[(pc + 2) % 3]);
			let cd0 = 0;
			let cd1 = 0;
			for (let i = 0; i < this.NC; i++) {
				cd0 += coneA[i] * phi[i];
				cd1 += coneB[i] * phi[i];
			}
			const cd2 = -cd0 - cd1;
			const dd = [0, 0, 0];
			dd[pc] = cd2;
			dd[(pc + 1) % 3] = cd0;
			dd[(pc + 2) % 3] = cd1;
			return [dd[0], dd[1]];
		}
		const phi = this.bEval(La, Lb, Lc);
		let da = 0;
		let db = 0;
		for (let i = 0; i < this.NB; i++) {
			da += ncA[i] * phi[i];
			db += ncB[i] * phi[i];
		}
		return [da, db];
	}
	private centerDisp(
		rl: number,
		sp1: number,
		La: number,
		Lb: number,
		Lc: number,
		par: number
	): [number, number] {
		if (rl in PENT)
			return this.field(rl, La, Lb, Lc, EMPTY, EMPTY, M.centerCone[par][0], M.centerCone[par][1]);
		const [ncA, ncB] = M.centerNC[`${rl}:${sp1}:${par}`];
		return this.field(rl, La, Lb, Lc, ncA, ncB, EMPTY, EMPTY);
	}
	private smoothDisp(
		rl: number,
		sp1: number,
		La: number,
		Lb: number,
		Lc: number
	): [number, number] {
		if (rl in PENT)
			return this.field(rl, La, Lb, Lc, EMPTY, EMPTY, M.smoothCone[0], M.smoothCone[1]);
		const [ncA, ncB] = M.smoothNC[`${rl}:${sp1}`];
		return this.field(rl, La, Lb, Lc, ncA, ncB, EMPTY, EMPTY);
	}

	// ---- geometry helpers
	private rootBary(p: Vec3, rl: Root): [number, number, number] {
		const b0 = dot(p, cross(rl.v1, rl.v2));
		const b1 = dot(p, cross(rl.v2, rl.v0));
		const b2 = dot(p, cross(rl.v0, rl.v1));
		const s = b0 + b1 + b2;
		return [b0 / s, b1 / s, b2 / s];
	}
	private rootFromBary(a: number, b: number, c: number, rl: Root): Vec3 {
		return normalize([
			a * rl.v0[0] + b * rl.v1[0] + c * rl.v2[0],
			a * rl.v0[1] + b * rl.v1[1] + c * rl.v2[1],
			a * rl.v0[2] + b * rl.v1[2] + c * rl.v2[2]
		]);
	}
	// integer lattice descent (mirrors icon.ts): corners of the leaf triangle
	private leafInfo(globalIndex: number) {
		const f = Math.floor(globalIndex / this.cpf);
		const inF = globalIndex - f * this.cpf;
		const rl = Math.floor(inF / this.cpr);
		let rest = inF - rl * this.cpr;
		let par = 0;
		let v0: [number, number] = [0, 0];
		let v1: [number, number] = [this.S, 0];
		let v2: [number, number] = [0, this.S];
		let sp1 = 0;
		for (let level = 0; level < this.k; level++) {
			const scale = 4 ** (this.k - 1 - level);
			const d = Math.floor(rest / scale);
			rest -= d * scale;
			if (level === 0) sp1 = d;
			const m01: [number, number] = [(v0[0] + v1[0]) / 2, (v0[1] + v1[1]) / 2];
			const m12: [number, number] = [(v1[0] + v2[0]) / 2, (v1[1] + v2[1]) / 2];
			const m20: [number, number] = [(v2[0] + v0[0]) / 2, (v2[1] + v0[1]) / 2];
			if (d === 0) {
				v1 = m01;
				v2 = m20;
			} else if (d === 1) {
				v0 = m01;
				v2 = m12;
			} else if (d === 2) {
				v0 = m12;
				v1 = m20;
				v2 = m01;
				par ^= 1;
			} else {
				v0 = m20;
				v1 = m12;
			}
		}
		return {
			f,
			rl,
			par,
			sp1,
			cor: [v0, v1, v2] as [[number, number], [number, number], [number, number]]
		};
	}

	// geometric leaf triangle of a cell by index (digit descent with spherical
	// midpoints) — the geometry the located point would descend to
	private leafGeom(globalIndex: number): Leaf {
		const f = Math.floor(globalIndex / this.cpf);
		const inF = globalIndex - f * this.cpf;
		const rl = Math.floor(inF / this.cpr);
		let rest = inF - rl * this.cpr;
		const root = this.faces[f].roots[rl];
		let v0 = root.v0;
		let v1 = root.v1;
		let v2 = root.v2;
		for (let level = 0; level < this.k; level++) {
			const scale = 4 ** (this.k - 1 - level);
			const d = Math.floor(rest / scale);
			rest -= d * scale;
			const m01 = mid(v0, v1);
			const m12 = mid(v1, v2);
			const m20 = mid(v2, v0);
			if (d === 0) {
				v1 = m01;
				v2 = m20;
			} else if (d === 1) {
				v0 = m01;
				v2 = m12;
			} else if (d === 2) {
				v0 = m12;
				v1 = m20;
				v2 = m01;
			} else {
				v0 = m20;
				v1 = m12;
			}
		}
		return { index: globalIndex, v0, v1, v2 };
	}

	// geometric cell location (face arg-max + root min-score + bisection descent),
	// with a same-root seed for scan coherence
	private locate(p: Vec3): Leaf {
		let face = 0;
		let rootLocal = 0;
		const seedRoot =
			this.seedValid &&
			(() => {
				const rt = this.faces[this.seedFace].roots[this.seedRoot];
				return dot(p, rt.n01) >= -1e-9 && dot(p, rt.n12) >= -1e-9 && dot(p, rt.n20) >= -1e-9;
			})();
		if (seedRoot) {
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
			const roots = this.faces[face].roots;
			let bestScore = -Infinity;
			for (let r = 0; r < roots.length; r++) {
				const s = Math.min(dot(p, roots[r].n01), dot(p, roots[r].n12), dot(p, roots[r].n20));
				if (s > bestScore) {
					bestScore = s;
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
		let index = (face * this.n * this.n + rootLocal) * this.cpr;
		let scale = this.cpr;
		for (let level = 0; level < this.k; level++) {
			scale /= 4;
			const m01 = mid(v0, v1);
			const m12 = mid(v1, v2);
			const m20 = mid(v2, v0);
			const c0 = cross(m01, m20);
			if (dot(p, c0) * dot(v0, c0) >= 0) {
				v1 = m01;
				v2 = m20;
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

	// ---- public API
	getBounds(): Bounds {
		return [-180, -90, 180, 90];
	}
	getCenter(): { lng: number; lat: number } {
		return { lng: 0, lat: 0 };
	}
	getCoveringRanges(): DimensionRange[] {
		return [
			{ start: 0, end: this.ny },
			{ start: 0, end: this.nx }
		];
	}

	private centerVec(globalIndex: number): Vec3 {
		const { f, rl, par, sp1, cor } = this.leafInfo(globalIndex);
		const I = (cor[0][0] + cor[1][0] + cor[2][0]) / 3;
		const J = (cor[0][1] + cor[1][1] + cor[2][1]) / 3;
		const La = 1 - (I + J) / this.S;
		const Lb = I / this.S;
		const [da, db] = this.centerDisp(rl, sp1, La, Lb, 1 - La - Lb, par);
		return this.rootFromBary(La + da, Lb + db, 1 - La - da - Lb - db, this.faces[f].roots[rl]);
	}

	cellCoordinates(index: number): { lat: number; lon: number } {
		return vecToLatLon(this.centerVec(index + this.nxStart));
	}

	cellVertices(index: number): { lat: number; lon: number }[] {
		const { f, rl, sp1, cor } = this.leafInfo(index + this.nxStart);
		const root = this.faces[f].roots[rl];
		const out: { lat: number; lon: number }[] = [];
		for (let s = 0; s < 3; s++) {
			const La = 1 - (cor[s][0] + cor[s][1]) / this.S;
			const Lb = cor[s][0] / this.S;
			const [da, db] = this.smoothDisp(rl, sp1, La, Lb, 1 - La - Lb);
			out.push(vecToLatLon(this.rootFromBary(La + da, Lb + db, 1 - La - da - Lb - db, root)));
		}
		return out;
	}

	// inverse-warp a true point into the geometric grid (smooth field, 2 fixed-
	// point steps within the located root), then greedy-snap to the nearest true
	// centre so findCell(cellCoordinates(i)) == i.
	findCell(lat: number, lon: number): number {
		const p = latLonToVec(lat, lon);
		const g0 = this.locate(p);
		const info0 = this.leafInfo(g0.index);
		const root = this.faces[info0.f].roots[info0.rl];
		const tb = this.rootBary(p, root);
		let a = tb[0];
		let b = tb[1];
		for (let it = 0; it < 2; it++) {
			const [da, db] = this.smoothDisp(info0.rl, info0.sp1, a, b, 1 - a - b);
			a = tb[0] - da;
			b = tb[1] - db;
		}
		let cand = this.locate(this.rootFromBary(a, b, 1 - a - b, root)).index;
		// greedy descent to the nearest true centre among edge neighbours
		let bestDot = dot(this.centerVec(cand), p);
		for (let iter = 0; iter < 5; iter++) {
			const leaf = this.leafGeom(cand); // candidate's geometric leaf triangle
			const gv = [leaf.v0, leaf.v1, leaf.v2];
			const gc = normalize([
				gv[0][0] + gv[1][0] + gv[2][0],
				gv[0][1] + gv[1][1] + gv[2][1],
				gv[0][2] + gv[1][2] + gv[2][2]
			]);
			let moved = false;
			for (let s = 0; s < 3; s++) {
				const nrm = normalize(cross(gv[s], gv[(s + 1) % 3]));
				const d2 = 2 * dot(gc, nrm);
				const refl: Vec3 = [gc[0] - d2 * nrm[0], gc[1] - d2 * nrm[1], gc[2] - d2 * nrm[2]];
				const nb = this.locate(refl).index;
				const d = dot(this.centerVec(nb), p);
				if (d > bestDot) {
					bestDot = d;
					cand = nb;
					moved = true;
				}
			}
			if (!moved) break;
		}
		return cand - this.nxStart;
	}

	getNearestNeighborValue(values: Float32Array, lat: number, lon: number): number {
		return values[this.findCell(lat, lon)];
	}
	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number {
		return this.getInterpolatedValue(values, lat, lon, 'linear');
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
			case 'cubic':
			case 'monotone':
			case 'linear':
				return this.getDualValue(values, lat, lon);
			default: {
				const _exhaustive: never = method;
				throw new Error(`Unknown interpolation method: ${_exhaustive}`);
			}
		}
	}

	// ---- dual-mesh linear interpolation (mean-value coords over the ring of
	// cell centres around the nearest primal vertex) — same scheme as IconGrid.
	private static nearestVert(v0: Vec3, v1: Vec3, v2: Vec3, t: Vec3): number {
		const d0 = dot(v0, t);
		const d1 = dot(v1, t);
		const d2 = dot(v2, t);
		return d0 >= d1 ? (d0 >= d2 ? 0 : 2) : d1 >= d2 ? 1 : 2;
	}
	private vertexRing(cell: Leaf, V: Vec3): void {
		this.dfCount = 0;
		let cur = cell;
		const vi = IconGridAnalytical.nearestVert(cur.v0, cur.v1, cur.v2, V);
		let shared = [cur.v0, cur.v1, cur.v2][(vi + 1) % 3];
		for (let step = 0; step < 8; step++) {
			this.dfIdx[this.dfCount] = cur.index - this.nxStart;
			this.dfCenters[this.dfCount] = this.centerVec(cur.index);
			this.dfCount++;
			const nrm = normalize(cross(V, shared));
			const gc = normalize([
				cur.v0[0] + cur.v1[0] + cur.v2[0],
				cur.v0[1] + cur.v1[1] + cur.v2[1],
				cur.v0[2] + cur.v1[2] + cur.v2[2]
			]);
			const d2 = 2 * dot(gc, nrm);
			const next = this.locate([gc[0] - d2 * nrm[0], gc[1] - d2 * nrm[1], gc[2] - d2 * nrm[2]]);
			if (next.index === cell.index) break;
			const nv = [next.v0, next.v1, next.v2];
			const nvi = IconGridAnalytical.nearestVert(nv[0], nv[1], nv[2], V);
			const nsi = IconGridAnalytical.nearestVert(nv[0], nv[1], nv[2], shared);
			shared = nv[3 - nvi - nsi];
			cur = next;
		}
	}
	private interpDual(values: Float32Array, p: Vec3): number {
		const m = this.dfCount;
		const C = this.dfCenters;
		const I = this.dfIdx;
		const px = dot(p, this.dfE1);
		const py = dot(p, this.dfE2);
		const Sx = this.dfSx;
		const Sy = this.dfSy;
		const R = this.dfR;
		for (let i = 0; i < m; i++) {
			const sx = dot(C[i], this.dfE1) - px;
			const sy = dot(C[i], this.dfE2) - py;
			const r = Math.sqrt(sx * sx + sy * sy);
			if (r < 1e-12) return roundWithPrecision(values[I[i]]);
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
			const crP = Sx[h] * Sy[i] - Sy[h] * Sx[i];
			const crN = Sx[i] * Sy[j] - Sy[i] * Sx[j];
			const tP = crP !== 0 ? (R[h] * R[i] - (Sx[h] * Sx[i] + Sy[h] * Sy[i])) / crP : 0;
			const tN = crN !== 0 ? (R[i] * R[j] - (Sx[i] * Sx[j] + Sy[i] * Sy[j])) / crN : 0;
			const w = (tP + tN) / R[i];
			const v = values[I[i]];
			if (isFinite(v)) {
				s += w * v;
				wsum += w;
			} else missing += w;
		}
		if (wsum === 0 || Math.abs(missing) > Math.abs(wsum)) return NaN;
		return roundWithPrecision(s / wsum);
	}
	private getDualValue(values: Float32Array, lat: number, lon: number): number {
		const p = latLonToVec(lat, lon);
		if (this.dfValid) {
			const o = this.dfOrient;
			let inside = true;
			for (let i = 0; i < this.dfCount; i++)
				if (dot(p, this.dfEdge[i]) * o <= 0) {
					inside = false;
					break;
				}
			if (inside) return this.interpDual(values, p);
		}
		const cell = this.locate(p);
		const order = [IconGridAnalytical.nearestVert(cell.v0, cell.v1, cell.v2, p)];
		order.push((order[0] + 1) % 3, (order[0] + 2) % 3);
		for (let a = 0; a < 3; a++) {
			const V = [cell.v0, cell.v1, cell.v2][order[a]];
			this.vertexRing(cell, V);
			const m = this.dfCount;
			for (let i = 0; i < m; i++)
				this.dfEdge[i] = cross(this.dfCenters[i], this.dfCenters[(i + 1) % m]);
			let cx = 0;
			let cy = 0;
			let cz = 0;
			for (let i = 0; i < m; i++) {
				cx += this.dfCenters[i][0];
				cy += this.dfCenters[i][1];
				cz += this.dfCenters[i][2];
			}
			const cen: Vec3 = [cx, cy, cz];
			this.dfOrient = dot(cen, this.dfEdge[0]) >= 0 ? 1 : -1;
			const o = this.dfOrient;
			let inside = true;
			for (let i = 0; i < m; i++)
				if (dot(p, this.dfEdge[i]) * o <= 0) {
					inside = false;
					break;
				}
			if (inside || a === 2) {
				this.dfG = normalize(cen);
				const [e1, e2] = tangentFrame(this.dfG);
				this.dfE1 = e1;
				this.dfE2 = e2;
				this.dfValid = true;
				return this.interpDual(values, p);
			}
		}
		return values[cell.index - this.nxStart];
	}

	forEachPoint(callback: (point: GridPoint) => void | false, bounds?: Bounds): void {
		for (let index = 0; index < this.nx; index++) {
			const { lat, lon } = this.cellCoordinates(index - this.nxStart);
			if (bounds && (lat < bounds[1] || lat > bounds[3] || lon < bounds[0] || lon > bounds[2]))
				continue;
			if (callback({ index: index - this.nxStart, lat, lon }) === false) return;
		}
	}
}
