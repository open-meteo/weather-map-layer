import {
	degreesToRadians,
	lat2tile,
	lon2tile,
	normalizeLon,
	radiansToDegrees,
	tile2lat,
	tile2lon
} from '../../utils/math';
import { GridInterface, GridPoint } from '../interface';
import Delaunator from 'delaunator';

import { Bounds, DimensionRange, InterpolationMethod, LatBandGridData } from '../../types';

// File-backed grid over the cell index the backend publishes for every native
// ICON domain (open-meteo `ReducedLatLon`, `data/<domain>/static/grid.bin`,
// format LATBAND1): the cell centres of a global or limited-area icosahedral
// mesh as float32 unit vectors with their cell index, bucketed into
// equal-height latitude bands and cos(lat)-scaled longitude columns. The API's
// point lookup uses the same file, so map and API attribute a coordinate to
// the same cell.
//
// Cells are rendered from their centres alone, no mesh connectivity needed:
//   - 'nearest' attributes a coordinate to the nearest centre. For a Delaunay-
//     like mesh the boundary between two cells is parallel to their shared
//     edge, offset by half the difference of the two centre-to-edge distances
//     (a few percent of a cell on ICON grids), so the triangles are reproduced
//     up to that shift.
//   - 'linear' (also used for cubic/monotone) is barycentric interpolation on
//     the Delaunay triangulation of the centres in view, i.e. the dual mesh,
//     so it is exact at every cell centre and linear in between.
// A coordinate more than 1.5 cell spacings from any centre belongs to no cell
// (the API's acceptance radius for ICON), which bounds a limited-area grid
// half a cell beyond its outermost centres.
//
// Layout (little endian, ReducedLatLonArtifact.swift): 64-byte header [magic
// 'LATBAND1', version u32, count, bandCount, firstBand, storedBands, buckets,
// number, global, uuid(16), reserved(8)], storedBands × 16-byte band
// [columns, startColumn, storedColumns, firstBucket], a bucket directory of
// (buckets + 1) u32 record positions, 16-byte records [x, y, z f32, id u32]
// from the next 16-byte boundary, then a reverse directory u32[id] → record
// (unused here: every lookup already yields the record).

interface Band {
	columns: number;
	startColumn: number;
	storedColumns: number;
	firstBucket: number;
}

export interface LatBandIndex {
	count: number;
	bandCount: number;
	firstBand: number;
	bands: Band[];
	global: boolean;
	/** bucket b holds records [directory[b], directory[b + 1]) */
	directory: Uint32Array;
	/** 4 floats per record: unit vector x, y, z, then the cell index (read via `ids`) */
	records: Float32Array;
	ids: Uint32Array;
	/** mean centre spacing in radians: sqrt(covered area / cells) */
	spacing: number;
}

const MAGIC = 'LATBAND1';
const HEADER_BYTES = 64;
const BAND_BYTES = 16;
const RECORD_BYTES = 16;
// nearest-neighbour candidates kept per query, enough for the ring of cells
// around the containing dual triangle
const CANDIDATES = 16;
// above this many centres in a tile the mesh is decimated before triangulating:
// the cells are sub-pixel anyway and a Delaunay of the full set would dominate
const MAX_TRIANGULATED = 50000;
const MERCATOR_LAT_LIMIT = 85.0511;

export const parseLatBand = (buffer: ArrayBufferLike): LatBandIndex => {
	if (buffer.byteLength < HEADER_BYTES) throw new Error('LATBAND1 grid file is truncated');
	const magic = String.fromCharCode(...new Uint8Array(buffer, 0, MAGIC.length));
	if (magic !== MAGIC) throw new Error('Not a LATBAND1 grid file');
	const view = new DataView(buffer);
	const u32 = (offset: number) => view.getUint32(offset, true);
	const version = u32(8);
	if (version !== 1) throw new Error(`Unsupported LATBAND1 version ${version}`);
	const count = u32(12);
	const bandCount = u32(16);
	const firstBand = u32(20);
	const storedBands = u32(24);
	const buckets = u32(28);
	const global = u32(36) === 1;
	const bands: Band[] = [];
	for (let i = 0; i < storedBands; i++) {
		const o = HEADER_BYTES + i * BAND_BYTES;
		bands.push({
			columns: u32(o),
			startColumn: u32(o + 4),
			storedColumns: u32(o + 8),
			firstBucket: u32(o + 12)
		});
	}
	const directoryOffset = HEADER_BYTES + storedBands * BAND_BYTES;
	const recordsOffset =
		Math.ceil((directoryOffset + (buckets + 1) * 4) / RECORD_BYTES) * RECORD_BYTES;
	const expectedBytes = recordsOffset + count * RECORD_BYTES + count * 4;
	if (buffer.byteLength !== expectedBytes) {
		throw new Error(`LATBAND1 grid file has ${buffer.byteLength} bytes, expected ${expectedBytes}`);
	}
	const bandHeight = Math.PI / bandCount;
	let area = 0;
	bands.forEach((band, i) => {
		const lat = -Math.PI / 2 + (firstBand + i + 0.5) * bandHeight;
		area += band.storedColumns * ((2 * Math.PI) / band.columns) * bandHeight * Math.cos(lat);
	});
	return {
		count,
		bandCount,
		firstBand,
		bands,
		global,
		directory: new Uint32Array(buffer, directoryOffset, buckets + 1),
		records: new Float32Array(buffer, recordsOffset, count * 4),
		ids: new Uint32Array(buffer, recordsOffset, count * 4),
		spacing: Math.sqrt(area / count)
	};
};

const normalizeDegrees = (deg: number): number => ((deg % 360) + 360) % 360;

export class LatBandGrid implements GridInterface {
	private readonly nx: number;
	private readonly ny: number;
	private readonly nxStart: number;
	private readonly index: LatBandIndex;
	private readonly bandHeight: number;
	// radius (radians) within which a coordinate is attributed to a centre, and
	// the wider radius the interpolation gathers its neighbourhood from
	private readonly acceptRadius: number;
	private readonly gatherRadius: number;
	private readonly acceptChord2: number;
	private readonly gatherChord2: number;
	private readonly bounds: Bounds;

	// neighbourhood of the last query, nearest first (see search)
	private readonly candId = new Int32Array(CANDIDATES);
	private readonly candDist = new Float64Array(CANDIDATES);
	private readonly candX = new Float64Array(CANDIDATES);
	private readonly candY = new Float64Array(CANDIDATES);
	private readonly candZ = new Float64Array(CANDIDATES);
	private candCount = 0;

	constructor(
		data: LatBandGridData,
		geometry: ArrayBufferLike,
		ranges: DimensionRange[] | null = null
	) {
		this.index = parseLatBand(geometry);
		if (data.nx !== this.index.count) {
			throw new Error(
				`latband grid file has ${this.index.count} cells, but domain declares nx=${data.nx}`
			);
		}
		this.nx = data.nx;
		this.ny = data.ny;
		this.nxStart = ranges ? ranges[1].start : 0;
		this.bandHeight = Math.PI / this.index.bandCount;
		this.acceptRadius = 1.5 * this.index.spacing;
		this.gatherRadius = 2.5 * this.index.spacing;
		this.acceptChord2 = 4 * Math.sin(this.acceptRadius / 2) ** 2;
		this.gatherChord2 = 4 * Math.sin(this.gatherRadius / 2) ** 2;
		this.bounds = this.computeBounds();
	}

	private computeBounds(): Bounds {
		const { bands, firstBand, bandCount, global } = this.index;
		if (global) return [-180, -90, 180, 90];
		const bandDeg = 180 / bandCount;
		let west = Infinity;
		let east = -Infinity;
		for (const band of bands) {
			if (band.storedColumns === 0) continue;
			const degPerColumn = 360 / band.columns;
			const lonWest = -180 + band.startColumn * degPerColumn;
			west = Math.min(west, lonWest);
			east = Math.max(east, lonWest + band.storedColumns * degPerColumn);
		}
		return [west, -90 + firstBand * bandDeg, east, -90 + (firstBand + bands.length) * bandDeg];
	}

	getBounds(): Bounds {
		return this.bounds;
	}

	getCenter(): { lng: number; lat: number } {
		const [west, south, east, north] = this.bounds;
		return { lng: (west + east) / 2, lat: (south + north) / 2 };
	}

	getBoundaryPolygon(): Array<[number, number]> {
		const { bands, firstBand, bandCount, global } = this.index;
		if (global) {
			return [
				[-180, -90],
				[180, -90],
				[180, 90],
				[-180, 90],
				[-180, -90]
			];
		}
		// The stored column span of each band outlines the data at bucket
		// resolution: west edges bottom-up, east edges top-down. Consecutive bands
		// with the same edge longitude merge into one vertical segment.
		const bandDeg = 180 / bandCount;
		const west: Array<[number, number]> = [];
		const east: Array<[number, number]> = [];
		const extend = (edge: Array<[number, number]>, lon: number, lat0: number, lat1: number) => {
			const last = edge[edge.length - 1];
			if (last && last[0] === lon) last[1] = lat1;
			else edge.push([lon, lat0], [lon, lat1]);
		};
		bands.forEach((band, i) => {
			if (band.storedColumns === 0) return;
			const lat0 = -90 + (firstBand + i) * bandDeg;
			const degPerColumn = 360 / band.columns;
			const lonWest = -180 + band.startColumn * degPerColumn;
			extend(west, lonWest, lat0, lat0 + bandDeg);
			extend(east, lonWest + band.storedColumns * degPerColumn, lat0, lat0 + bandDeg);
		});
		east.reverse();
		return [...west, ...east, west[0]];
	}

	getCoveringRanges(
		_south: number,
		_west: number,
		_north: number,
		_east: number
	): DimensionRange[] {
		// Cell order is the model's, not spatial: a lat/lon box maps to scattered
		// indices, so the whole array is read.
		return [
			{ start: 0, end: this.ny },
			{ start: 0, end: this.nx }
		];
	}

	/**
	 * Nearest centre within the acceptance radius, or -1. With `gather` the
	 * neighbourhood within the gather radius is kept in the candidate arrays,
	 * nearest first.
	 */
	private search(lat: number, lon: number, gather: boolean): number {
		const index = this.index;
		const latR = degreesToRadians(Math.max(-90, Math.min(90, lat)));
		const lonR = degreesToRadians(normalizeLon(lon));
		const cosLat = Math.cos(latR);
		const px = cosLat * Math.cos(lonR);
		const py = cosLat * Math.sin(lonR);
		const pz = Math.sin(latR);
		const radius = gather ? this.gatherRadius : this.acceptRadius;
		const limit = gather ? this.gatherChord2 : this.acceptChord2;
		const bandReach = Math.ceil(radius / this.bandHeight);
		const band = Math.floor((latR + Math.PI / 2) / this.bandHeight);
		const halfWidth = Math.min(Math.PI, radius / Math.max(cosLat, 1e-6));
		let best = -1;
		let bestDist = this.acceptChord2;
		this.candCount = 0;
		for (let b = band - bandReach; b <= band + bandReach; b++) {
			const bi = b - index.firstBand;
			if (bi < 0 || bi >= index.bands.length) continue;
			const stored = index.bands[bi];
			const scale = stored.columns / (2 * Math.PI);
			let c0 = Math.floor((lonR - halfWidth + Math.PI) * scale);
			let c1 = Math.floor((lonR + halfWidth + Math.PI) * scale);
			if (c1 - c0 + 1 >= stored.columns) {
				c0 = 0;
				c1 = stored.columns - 1;
			}
			for (let c = c0; c <= c1; c++) {
				let column = c % stored.columns;
				if (column < 0) column += stored.columns;
				let local = column - stored.startColumn;
				if (local < 0) local += stored.columns;
				if (local >= stored.storedColumns) continue;
				const bucket = stored.firstBucket + local;
				const end = index.directory[bucket + 1];
				for (let r = index.directory[bucket]; r < end; r++) {
					const o = r * 4;
					const x = index.records[o];
					const y = index.records[o + 1];
					const z = index.records[o + 2];
					const dx = x - px;
					const dy = y - py;
					const dz = z - pz;
					const dist = dx * dx + dy * dy + dz * dz;
					if (dist < bestDist) {
						bestDist = dist;
						best = index.ids[o + 3];
					}
					if (gather && dist < limit) this.addCandidate(index.ids[o + 3], dist, x, y, z);
				}
			}
		}
		return best;
	}

	// sorted insertion, dropping the farthest once the arrays are full
	private addCandidate(id: number, dist: number, x: number, y: number, z: number): void {
		let i = this.candCount;
		if (i === CANDIDATES) {
			if (dist >= this.candDist[i - 1]) return;
			i--;
		}
		while (i > 0 && this.candDist[i - 1] > dist) {
			this.candId[i] = this.candId[i - 1];
			this.candDist[i] = this.candDist[i - 1];
			this.candX[i] = this.candX[i - 1];
			this.candY[i] = this.candY[i - 1];
			this.candZ[i] = this.candZ[i - 1];
			i--;
		}
		this.candId[i] = id;
		this.candDist[i] = dist;
		this.candX[i] = x;
		this.candY[i] = y;
		this.candZ[i] = z;
		if (this.candCount < CANDIDATES) this.candCount++;
	}

	/** Index of the cell a coordinate belongs to, or -1 outside the grid. */
	findCell(lat: number, lon: number): number {
		return this.search(lat, lon, false);
	}

	getNearestNeighborValue(values: Float32Array, lat: number, lon: number): number {
		const cell = this.search(lat, lon, false);
		return cell < 0 ? NaN : values[cell - this.nxStart];
	}

	/**
	 * Barycentric interpolation on the dual-mesh triangle containing the point:
	 * among the triangles of the nearest centres that contain it, the one with
	 * the smallest circumradius (the Delaunay choice for a well-shaped mesh).
	 * Falls back to inverse-distance weighting when no such triangle exists
	 * (edge of a limited-area grid, missing values).
	 */
	private interpolate(values: Float32Array, lat: number, lon: number, angular: boolean): number {
		if (this.search(lat, lon, true) < 0) return NaN;
		const n = this.candCount;
		const latR = degreesToRadians(lat);
		const lonR = degreesToRadians(lon);
		// orthographic coordinates in the tangent plane at the query point
		const ex = -Math.sin(lonR);
		const ey = Math.cos(lonR);
		const nxv = -Math.sin(latR) * Math.cos(lonR);
		const nyv = -Math.sin(latR) * Math.sin(lonR);
		const nzv = Math.cos(latR);
		const u = new Float64Array(n);
		const v = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			u[i] = this.candX[i] * ex + this.candY[i] * ey;
			v[i] = this.candX[i] * nxv + this.candY[i] * nyv + this.candZ[i] * nzv;
		}
		const k = Math.min(n, 8);
		let bi = -1;
		let bj = -1;
		let bk = -1;
		let bestRadius = Infinity;
		for (let i = 0; i < k; i++) {
			for (let j = i + 1; j < k; j++) {
				for (let m = j + 1; m < k; m++) {
					// the origin is inside when it lies on the same side of all edges
					const s0 = u[i] * v[j] - u[j] * v[i];
					const s1 = u[j] * v[m] - u[m] * v[j];
					const s2 = u[m] * v[i] - u[i] * v[m];
					if (!((s0 >= 0 && s1 >= 0 && s2 >= 0) || (s0 <= 0 && s1 <= 0 && s2 <= 0))) continue;
					const area2 = s0 + s1 + s2;
					if (area2 === 0) continue;
					const a2 = (u[i] - u[j]) ** 2 + (v[i] - v[j]) ** 2;
					const b2 = (u[j] - u[m]) ** 2 + (v[j] - v[m]) ** 2;
					const c2 = (u[m] - u[i]) ** 2 + (v[m] - v[i]) ** 2;
					const radius2 = (a2 * b2 * c2) / (4 * area2 * area2);
					if (radius2 < bestRadius) {
						bestRadius = radius2;
						bi = i;
						bj = j;
						bk = m;
					}
				}
			}
		}
		let ids: number[];
		let weights: number[];
		if (bi >= 0) {
			const s0 = u[bi] * v[bj] - u[bj] * v[bi];
			const s1 = u[bj] * v[bk] - u[bk] * v[bj];
			const s2 = u[bk] * v[bi] - u[bi] * v[bk];
			const total = s0 + s1 + s2;
			ids = [this.candId[bi], this.candId[bj], this.candId[bk]];
			weights = [s1 / total, s2 / total, s0 / total];
		} else {
			ids = [];
			weights = [];
		}
		if (ids.some((id) => !isFinite(values[id - this.nxStart]))) {
			ids = [];
			weights = [];
		}
		if (ids.length === 0) {
			// inverse-distance weighting over the nearest finite values
			for (let i = 0; i < n && ids.length < 4; i++) {
				const id = this.candId[i];
				if (!isFinite(values[id - this.nxStart])) continue;
				if (this.candDist[i] === 0) return this.finish(values[id - this.nxStart], angular);
				ids.push(id);
				weights.push(1 / this.candDist[i]);
			}
			if (ids.length === 0) return NaN;
		}
		let sum = 0;
		let sx = 0;
		let sy = 0;
		let wsum = 0;
		for (let i = 0; i < ids.length; i++) {
			const value = values[ids[i] - this.nxStart];
			const w = weights[i];
			if (angular) {
				const rad = degreesToRadians(value);
				sx += w * Math.cos(rad);
				sy += w * Math.sin(rad);
			} else {
				sum += w * value;
			}
			wsum += w;
		}
		if (angular) return normalizeDegrees(radiansToDegrees(Math.atan2(sy / wsum, sx / wsum)));
		return sum / wsum;
	}

	private finish(value: number, angular: boolean): number {
		return angular ? normalizeDegrees(value) : value;
	}

	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number {
		return this.interpolate(values, lat, lon, false);
	}

	getLinearInterpolatedDirection(values: Float32Array, lat: number, lon: number): number {
		return this.interpolate(values, lat, lon, true);
	}

	getInterpolatedValue(
		values: Float32Array,
		lat: number,
		lon: number,
		method: InterpolationMethod
	): number {
		if (method === 'nearest') return this.getNearestNeighborValue(values, lat, lon);
		return this.interpolate(values, lat, lon, false);
	}

	/** Visits the records of every stored bucket touching the lat/lon box. */
	private forEachRecordInBox(
		south: number,
		west: number,
		north: number,
		east: number,
		callback: (x: number, y: number, z: number, id: number) => void
	): void {
		const index = this.index;
		const b0 = Math.floor((degreesToRadians(Math.max(-90, south)) + Math.PI / 2) / this.bandHeight);
		const b1 = Math.floor((degreesToRadians(Math.min(90, north)) + Math.PI / 2) / this.bandHeight);
		const lonW = degreesToRadians(west);
		const lonE = degreesToRadians(east);
		for (let b = b0; b <= b1; b++) {
			const bi = b - index.firstBand;
			if (bi < 0 || bi >= index.bands.length) continue;
			const stored = index.bands[bi];
			const scale = stored.columns / (2 * Math.PI);
			let c0 = Math.floor((lonW + Math.PI) * scale);
			let c1 = Math.floor((lonE + Math.PI) * scale);
			if (c1 - c0 + 1 >= stored.columns) {
				c0 = 0;
				c1 = stored.columns - 1;
			}
			for (let c = c0; c <= c1; c++) {
				let column = c % stored.columns;
				if (column < 0) column += stored.columns;
				let local = column - stored.startColumn;
				if (local < 0) local += stored.columns;
				if (local >= stored.storedColumns) continue;
				const bucket = stored.firstBucket + local;
				const end = index.directory[bucket + 1];
				for (let r = index.directory[bucket]; r < end; r++) {
					const o = r * 4;
					callback(index.records[o], index.records[o + 1], index.records[o + 2], index.ids[o + 3]);
				}
			}
		}
	}

	forEachPoint(callback: (point: GridPoint) => void | false, bounds?: Bounds): void {
		let stopped = false;
		const visit = (x: number, y: number, z: number, id: number) => {
			if (stopped) return;
			const lat = radiansToDegrees(Math.asin(Math.max(-1, Math.min(1, z))));
			const lon = radiansToDegrees(Math.atan2(y, x));
			if (bounds && (lat < bounds[1] || lat > bounds[3] || lon < bounds[0] || lon > bounds[2]))
				return;
			if (callback({ index: id - this.nxStart, lat, lon }) === false) stopped = true;
		};
		if (bounds) {
			this.forEachRecordInBox(bounds[1], bounds[0], bounds[3], bounds[2], visit);
			return;
		}
		const { records, ids, count } = this.index;
		for (let r = 0; r < count && !stopped; r++) {
			const o = r * 4;
			visit(records[o], records[o + 1], records[o + 2], ids[o + 3]);
		}
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
		const lons = new Float64Array(tileSize);
		for (let j = 0; j < tileSize; j++) lons[j] = tile2lon(x + (j + 0.5) / tileSize, z);
		if (method !== 'nearest') this.rasteriseLinear(values, x, y, z, tileSize, out);
		// nearest fill: the whole tile for 'nearest', otherwise only the pixels the
		// triangulation left out (beyond the outermost centres of a limited-area
		// grid, or triangles with a missing value)
		for (let i = 0; i < tileSize; i++) {
			const lat = tile2lat(y + (i + 0.5) / tileSize, z);
			const row = i * tileSize;
			for (let j = 0; j < tileSize; j++) {
				if (method !== 'nearest' && out[row + j] === out[row + j]) continue;
				const cell = this.search(lat, lons[j], false);
				if (cell >= 0) out[row + j] = values[cell - this.nxStart];
			}
		}
		return out;
	}

	// Delaunay of the centres in and around the tile, Gouraud-filled in pixel space
	private rasteriseLinear(
		values: Float32Array,
		x: number,
		y: number,
		z: number,
		tileSize: number,
		out: Float32Array
	): void {
		const worldPx = 2 ** z * tileSize;
		const lonL = tile2lon(x, z);
		const lonR = tile2lon(x + 1, z);
		const latT = tile2lat(y, z);
		const latB = tile2lat(y + 1, z);
		// one gather radius of margin so triangles straddling the tile edge exist
		const marginLat = radiansToDegrees(this.gatherRadius);
		const marginLon = marginLat / Math.max(0.05, Math.cos(degreesToRadians((latT + latB) / 2)));
		const coords: number[] = [];
		const cells: number[] = [];
		this.forEachRecordInBox(
			latB - marginLat,
			lonL - marginLon,
			latT + marginLat,
			lonR + marginLon,
			(cx, cy, cz, id) => {
				const lat = Math.max(
					-MERCATOR_LAT_LIMIT,
					Math.min(MERCATOR_LAT_LIMIT, radiansToDegrees(Math.asin(Math.max(-1, Math.min(1, cz)))))
				);
				const lon = radiansToDegrees(Math.atan2(cy, cx));
				let px = (lon2tile(lon, z) - x) * tileSize;
				// unwrap so centres across the antimeridian stay contiguous with the tile
				px -= Math.round((px - tileSize / 2) / worldPx) * worldPx;
				coords.push(px, (lat2tile(lat, z) - y) * tileSize);
				cells.push(id);
			}
		);
		let n = cells.length;
		if (n < 3) return;
		if (n > MAX_TRIANGULATED) {
			const stride = Math.ceil(n / MAX_TRIANGULATED);
			let kept = 0;
			for (let i = 0; i < n; i += stride) {
				coords[2 * kept] = coords[2 * i];
				coords[2 * kept + 1] = coords[2 * i + 1];
				cells[kept] = cells[i];
				kept++;
			}
			coords.length = 2 * kept;
			cells.length = kept;
			n = kept;
		}
		const triangles = new Delaunator(coords).triangles;
		for (let t = 0; t < triangles.length; t += 3) {
			const a = triangles[t];
			const b = triangles[t + 1];
			const c = triangles[t + 2];
			const va = values[cells[a] - this.nxStart];
			const vb = values[cells[b] - this.nxStart];
			const vc = values[cells[c] - this.nxStart];
			if (!isFinite(va) || !isFinite(vb) || !isFinite(vc)) continue;
			const ax = coords[2 * a];
			const ay = coords[2 * a + 1];
			const bx = coords[2 * b];
			const by = coords[2 * b + 1];
			const cx = coords[2 * c];
			const cy = coords[2 * c + 1];
			const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
			if (d === 0) continue;
			const inv = 1 / d;
			const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
			const maxX = Math.min(tileSize - 1, Math.ceil(Math.max(ax, bx, cx)));
			const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
			const maxY = Math.min(tileSize - 1, Math.ceil(Math.max(ay, by, cy)));
			for (let py = minY; py <= maxY; py++) {
				const sy = py + 0.5;
				const row = py * tileSize;
				for (let px = minX; px <= maxX; px++) {
					const sx = px + 0.5;
					const l0 = ((by - cy) * (sx - cx) + (cx - bx) * (sy - cy)) * inv;
					const l1 = ((cy - ay) * (sx - cx) + (ax - cx) * (sy - cy)) * inv;
					const l2 = 1 - l0 - l1;
					if (l0 >= 0 && l1 >= 0 && l2 >= 0) out[row + px] = l0 * va + l1 * vb + l2 * vc;
				}
			}
		}
	}
}
