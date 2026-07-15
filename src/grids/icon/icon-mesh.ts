import { lat2tile, lon2tile, tile2lat, tile2lon } from '../../utils/math';
import { GridInterface, GridPoint } from '../interface';

import {
	Bounds,
	DimensionRange,
	IconMeshGeometry,
	IconMeshGridData,
	InterpolationMethod
} from '../../types';

// File-based native ICON triangular grid, for the limited-area / nest models
// (ICON-D2 R19B07, ICON-EU nest) whose cells are NOT the global analytical
// icosahedron the IconGrid reconstructs. The geometry — unit-sphere vertex
// positions, the cell→vertex triangle connectivity and the cell-centre lat/lon —
// is loaded from a compact binary (see icon-native-test/extract-native-grid.mjs,
// magic 'ICNG') extracted from the official DWD grid description file.
//
// Rendering is the same forward rasterisation as IconGrid.renderTile (cell →
// pixels, exact triangular boundaries), but cells that fall in a tile are found
// with a coarse lat/lon bucket index instead of the icosahedral hierarchy, since
// there is no analytical hierarchy for a limited-area grid. Data (one value per
// cell) still comes from the regular product resampled onto the cell centres.

type Vec3 = [number, number, number];

/** Parse the compact 'ICNG' geometry binary into typed-array views. */
export function parseIconMeshGeometry(buf: ArrayBuffer): IconMeshGeometry {
	const head = new DataView(buf);
	if (head.getUint8(0) !== 0x49 || head.getUint8(1) !== 0x43)
		throw new Error('not an ICNG geometry blob');
	const nCells = head.getUint32(8, true);
	const nVert = head.getUint32(12, true);
	let o = 16;
	const verts = new Float32Array(buf, o, nVert * 3);
	o += nVert * 12;
	const voc = new Uint32Array(buf, o, nCells * 3);
	o += nCells * 12;
	const centres = new Float32Array(buf, o, nCells * 2);
	return { nCells, nVert, verts, voc, centres };
}

export class IconMeshGrid implements GridInterface {
	private readonly nCells: number;
	private readonly nVert: number;
	private readonly verts: Float32Array;
	private readonly voc: Uint32Array;
	private readonly centres: Float32Array;
	private readonly nxStart: number;

	// domain extent + coarse bucket index (CSR: bucketStart[b]..bucketStart[b+1]
	// index into cellByBucket) for tile pruning
	private readonly latMin: number;
	private readonly lonMin: number;
	private readonly bucketDeg = 0.5;
	private readonly nLatB: number;
	private readonly nLonB: number;
	private readonly bucketStart: Int32Array;
	private readonly cellByBucket: Int32Array;

	// vertex → incident cells (CSR), derived from the connectivity — the dual mesh
	// for the smooth (linear) vertex means. Built lazily on first smooth render.
	private vStart: Int32Array | null = null;
	private vCells: Int32Array | null = null;

	constructor(
		data: IconMeshGridData,
		geometry: IconMeshGeometry,
		ranges: DimensionRange[] | null = null
	) {
		if (geometry.nCells !== data.nx)
			throw new Error(
				`IconMeshGrid geometry has ${geometry.nCells} cells, domain declares nx=${data.nx}`
			);
		this.nCells = geometry.nCells;
		this.nVert = geometry.nVert;
		this.verts = geometry.verts;
		this.voc = geometry.voc;
		this.centres = geometry.centres;
		this.nxStart = ranges ? ranges[1].start : 0;

		// domain extent from cell centres
		let laMin = Infinity,
			laMax = -Infinity,
			loMin = Infinity,
			loMax = -Infinity;
		for (let i = 0; i < this.nCells; i++) {
			const la = this.centres[2 * i];
			const lo = this.centres[2 * i + 1];
			if (la < laMin) laMin = la;
			if (la > laMax) laMax = la;
			if (lo < loMin) loMin = lo;
			if (lo > loMax) loMax = lo;
		}
		this.latMin = laMin;
		this.lonMin = loMin;
		this.nLatB = Math.max(1, Math.ceil((laMax - laMin) / this.bucketDeg) + 1);
		this.nLonB = Math.max(1, Math.ceil((loMax - loMin) / this.bucketDeg) + 1);

		// bucket index by cell centre (counting sort into CSR)
		const nB = this.nLatB * this.nLonB;
		this.bucketStart = new Int32Array(nB + 1);
		const bucketOf = (i: number) => {
			const lb = ((this.centres[2 * i] - laMin) / this.bucketDeg) | 0;
			const ob = ((this.centres[2 * i + 1] - loMin) / this.bucketDeg) | 0;
			return lb * this.nLonB + ob;
		};
		for (let i = 0; i < this.nCells; i++) this.bucketStart[bucketOf(i) + 1]++;
		for (let b = 0; b < nB; b++) this.bucketStart[b + 1] += this.bucketStart[b];
		this.cellByBucket = new Int32Array(this.nCells);
		const cursor = this.bucketStart.slice(0, nB);
		for (let i = 0; i < this.nCells; i++) {
			const b = bucketOf(i);
			this.cellByBucket[cursor[b]++] = i;
		}
	}

	private buildVertexRings(): void {
		const deg = new Int32Array(this.nVert);
		for (let i = 0; i < this.voc.length; i++) deg[this.voc[i]]++;
		this.vStart = new Int32Array(this.nVert + 1);
		for (let v = 0; v < this.nVert; v++) this.vStart[v + 1] = this.vStart[v] + deg[v];
		this.vCells = new Int32Array(this.voc.length);
		const cursor = this.vStart.slice(0, this.nVert);
		for (let c = 0; c < this.nCells; c++)
			for (let j = 0; j < 3; j++) {
				const v = this.voc[3 * c + j];
				this.vCells[cursor[v]++] = c;
			}
	}

	// mean of the finite values of the cells sharing vertex v (dual-mesh value)
	private vertexValue(values: Float32Array, v: number): number {
		const s = this.vStart!;
		const cells = this.vCells!;
		let sum = 0,
			cnt = 0;
		for (let i = s[v]; i < s[v + 1]; i++) {
			const val = values[cells[i] - this.nxStart];
			if (isFinite(val)) {
				sum += val;
				cnt++;
			}
		}
		return cnt ? sum / cnt : NaN;
	}

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
		if (smooth && !this.vStart) this.buildVertexRings();
		const worldPx = 2 ** z * tileSize;
		const vcache = new Map<number, number>();

		const project = (vx: number, vy: number, vz: number): [number, number] => {
			const lat = (Math.asin(Math.max(-1, Math.min(1, vz))) * 180) / Math.PI;
			const lon = (Math.atan2(vy, vx) * 180) / Math.PI;
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

		// tile lat/lon box → bucket range (+1 bucket pad for cell extent + warp)
		const tLatT = tile2lat(y, z);
		const tLatB = tile2lat(y + 1, z);
		const tLonL = tile2lon(x, z);
		let tLonR = tile2lon(x + 1, z);
		if (tLonR <= tLonL) tLonR += 360;
		const lbLo = Math.max(0, Math.floor((tLatB - this.latMin) / this.bucketDeg) - 1);
		const lbHi = Math.min(this.nLatB - 1, Math.ceil((tLatT - this.latMin) / this.bucketDeg) + 1);
		const V = this.verts;
		for (let lb = lbLo; lb <= lbHi; lb++) {
			// longitude buckets, honouring wrap by scanning the tile's lon span
			for (
				let lonDeg = tLonL - this.bucketDeg;
				lonDeg <= tLonR + this.bucketDeg;
				lonDeg += this.bucketDeg
			) {
				let lonN = lonDeg;
				if (lonN > 180) lonN -= 360;
				const ob = Math.floor((lonN - this.lonMin) / this.bucketDeg);
				if (ob < 0 || ob >= this.nLonB) continue;
				const b = lb * this.nLonB + ob;
				for (let k = this.bucketStart[b]; k < this.bucketStart[b + 1]; k++) {
					const cell = this.cellByBucket[k];
					const i0 = this.voc[3 * cell],
						i1 = this.voc[3 * cell + 1],
						i2 = this.voc[3 * cell + 2];
					const p0 = project(V[3 * i0], V[3 * i0 + 1], V[3 * i0 + 2]);
					const p1 = project(V[3 * i1], V[3 * i1 + 1], V[3 * i1 + 2]);
					const p2 = project(V[3 * i2], V[3 * i2 + 1], V[3 * i2 + 2]);
					if (smooth) {
						const vv = (vi: number): number => {
							let val = vcache.get(vi);
							if (val === undefined) {
								val = this.vertexValue(values, vi);
								vcache.set(vi, val);
							}
							return val;
						};
						fill(p0, p1, p2, vv(i0), vv(i1), vv(i2));
					} else {
						const v = values[cell - this.nxStart];
						fill(p0, p1, p2, v, v, v);
					}
				}
			}
		}
		return out;
	}

	/**
	 * The cell containing a coordinate, or -1 when the point lies outside the
	 * limited-area domain. Scans the candidate bucket (and neighbours) for the
	 * triangle that contains the point on the sphere.
	 */
	findCell(lat: number, lon: number): number {
		const px = Math.cos((lat * Math.PI) / 180) * Math.cos((lon * Math.PI) / 180);
		const py = Math.cos((lat * Math.PI) / 180) * Math.sin((lon * Math.PI) / 180);
		const pz = Math.sin((lat * Math.PI) / 180);
		const lb = ((lat - this.latMin) / this.bucketDeg) | 0;
		const ob = ((lon - this.lonMin) / this.bucketDeg) | 0;
		const V = this.verts;
		for (let dlb = -1; dlb <= 1; dlb++)
			for (let dob = -1; dob <= 1; dob++) {
				const l = lb + dlb,
					o = ob + dob;
				if (l < 0 || l >= this.nLatB || o < 0 || o >= this.nLonB) continue;
				const b = l * this.nLonB + o;
				for (let k = this.bucketStart[b]; k < this.bucketStart[b + 1]; k++) {
					const cell = this.cellByBucket[k];
					const i0 = this.voc[3 * cell],
						i1 = this.voc[3 * cell + 1],
						i2 = this.voc[3 * cell + 2];
					// inside test: point on the same side of all three edge planes
					const a: Vec3 = [V[3 * i0], V[3 * i0 + 1], V[3 * i0 + 2]];
					const bb: Vec3 = [V[3 * i1], V[3 * i1 + 1], V[3 * i1 + 2]];
					const c: Vec3 = [V[3 * i2], V[3 * i2 + 1], V[3 * i2 + 2]];
					const s0 =
						px * (a[1] * bb[2] - a[2] * bb[1]) +
						py * (a[2] * bb[0] - a[0] * bb[2]) +
						pz * (a[0] * bb[1] - a[1] * bb[0]);
					const s1 =
						px * (bb[1] * c[2] - bb[2] * c[1]) +
						py * (bb[2] * c[0] - bb[0] * c[2]) +
						pz * (bb[0] * c[1] - bb[1] * c[0]);
					const s2 =
						px * (c[1] * a[2] - c[2] * a[1]) +
						py * (c[2] * a[0] - c[0] * a[2]) +
						pz * (c[0] * a[1] - c[1] * a[0]);
					if ((s0 >= 0 && s1 >= 0 && s2 >= 0) || (s0 <= 0 && s1 <= 0 && s2 <= 0))
						return cell - this.nxStart;
				}
			}
		return -1;
	}

	/** Cell-centre lat/lon (the mass point stored in the grid file). */
	cellCoordinates(index: number): { lat: number; lon: number } {
		const i = index + this.nxStart;
		return { lat: this.centres[2 * i], lon: this.centres[2 * i + 1] };
	}

	/** The three triangle corners of a cell (true grid-file vertex positions). */
	cellVertices(index: number): { lat: number; lon: number }[] {
		const i = index + this.nxStart;
		const out: { lat: number; lon: number }[] = [];
		for (let s = 0; s < 3; s++) {
			const v = this.voc[3 * i + s];
			const x = this.verts[3 * v],
				y = this.verts[3 * v + 1],
				z = this.verts[3 * v + 2];
			out.push({
				lat: (Math.asin(Math.max(-1, Math.min(1, z))) * 180) / Math.PI,
				lon: (Math.atan2(y, x) * 180) / Math.PI
			});
		}
		return out;
	}

	getNearestNeighborValue(values: Float32Array, lat: number, lon: number): number {
		const cell = this.findCell(lat, lon);
		return cell < 0 ? NaN : values[cell];
	}

	getInterpolatedValue(
		values: Float32Array,
		lat: number,
		lon: number,
		_method: InterpolationMethod
	): number {
		// per-pixel path is only used for point queries here; nearest is exact and
		// cheap. (Tiles are rendered via renderTile, which does linear too.)
		return this.getNearestNeighborValue(values, lat, lon);
	}

	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number {
		return this.getNearestNeighborValue(values, lat, lon);
	}

	getBounds(): Bounds {
		let laMin = Infinity,
			laMax = -Infinity,
			loMin = Infinity,
			loMax = -Infinity;
		for (let i = 0; i < this.nCells; i++) {
			const la = this.centres[2 * i],
				lo = this.centres[2 * i + 1];
			if (la < laMin) laMin = la;
			if (la > laMax) laMax = la;
			if (lo < loMin) loMin = lo;
			if (lo > loMax) loMax = lo;
		}
		return [loMin, laMin, loMax, laMax];
	}

	getCenter(): { lng: number; lat: number } {
		const [w, s, e, n] = this.getBounds();
		return { lng: (w + e) / 2, lat: (s + n) / 2 };
	}

	getCoveringRanges(): DimensionRange[] {
		// one flat cell dimension; the reader always loads every cell
		return [
			{ start: 0, end: 1 },
			{ start: 0, end: this.nCells }
		];
	}

	forEachPoint(callback: (point: GridPoint) => void | false, bounds?: Bounds): void {
		for (let i = 0; i < this.nCells; i++) {
			const lat = this.centres[2 * i],
				lon = this.centres[2 * i + 1];
			if (bounds && (lat < bounds[1] || lat > bounds[3] || lon < bounds[0] || lon > bounds[2]))
				continue;
			if (callback({ index: i, lat, lon }) === false) return;
		}
	}
}
