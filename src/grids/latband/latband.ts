import {
	degreesToRadians,
	normalizeLon,
	radiansToDegrees,
	tile2lat,
	tile2lon
} from '../../utils/math';
import { GridInterface, GridPoint } from '../interface';

import {
	type BufferConstructor,
	type LatBandTriangulation,
	triangulateLatBand
} from './triangulation';

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
//     the Delaunay triangulation of the centres, i.e. the dual mesh, so it is
//     exact at every cell centre and linear in between. The triangulation is
//     computed once per grid (triangulation.ts) and shared with the GPU layer,
//     so tiles and GPU interpolate on the same triangles, at every zoom.
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
// nearest-neighbour candidates kept per query for the inverse-distance fallback
const CANDIDATES = 16;
// the acceptance radius, and the longest triangle edge kept (see triangulation.ts)
const ACCEPT_SPACINGS = 1.5;
const MAX_EDGE_SPACINGS = Math.sqrt(3) * ACCEPT_SPACINGS;

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
	// the longest triangle edge (radians)
	private readonly triangleReach: number;
	/** The Delaunay triangulation of the centres, shared with the GPU layer. */
	readonly triangulation: LatBandTriangulation;

	// neighbourhood of the last query, nearest first (see search)
	private readonly candId = new Int32Array(CANDIDATES);
	private readonly candDist = new Float64Array(CANDIDATES);
	private candCount = 0;

	constructor(
		data: LatBandGridData,
		geometry: ArrayBufferLike,
		ranges: DimensionRange[] | null = null,
		/** The geometry's triangulation (see triangulate), computed here if absent. */
		triangulation?: LatBandTriangulation
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
		this.acceptRadius = ACCEPT_SPACINGS * this.index.spacing;
		this.gatherRadius = 2.5 * this.index.spacing;
		this.acceptChord2 = 4 * Math.sin(this.acceptRadius / 2) ** 2;
		this.gatherChord2 = 4 * Math.sin(this.gatherRadius / 2) ** 2;
		this.triangleReach = MAX_EDGE_SPACINGS * this.index.spacing;
		this.bounds = this.computeBounds();
		this.triangulation = triangulation ?? LatBandGrid.triangulate(geometry);
	}

	/**
	 * The triangulation of a LATBAND1 file's centres (see triangulation.ts):
	 * seconds for a global grid, so computed once per grid in a worker and
	 * passed to every LatBandGrid of it.
	 */
	static triangulate(geometry: ArrayBufferLike, Buffer?: BufferConstructor): LatBandTriangulation {
		const index = parseLatBand(geometry);
		return triangulateLatBand(index, MAX_EDGE_SPACINGS * index.spacing, Buffer);
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

	/** Mean centre spacing in radians (see LatBandIndex.spacing). */
	get spacing(): number {
		return this.index.spacing;
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
					if (gather && dist < limit) this.addCandidate(index.ids[o + 3], dist);
				}
			}
		}
		return best;
	}

	// sorted insertion, dropping the farthest once the arrays are full
	private addCandidate(id: number, dist: number): void {
		let i = this.candCount;
		if (i === CANDIDATES) {
			if (dist >= this.candDist[i - 1]) return;
			i--;
		}
		while (i > 0 && this.candDist[i - 1] > dist) {
			this.candId[i] = this.candId[i - 1];
			this.candDist[i] = this.candDist[i - 1];
			i--;
		}
		this.candId[i] = id;
		this.candDist[i] = dist;
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
	 * Barycentric interpolation on the triangle of the grid triangulation (the
	 * dual mesh) containing the point, the same triangle the tiles and the GPU
	 * layer fill. Falls back to inverse-distance weighting when no such triangle
	 * exists (edge of a limited-area grid, missing values).
	 */
	private interpolate(values: Float32Array, lat: number, lon: number, angular: boolean): number {
		if (this.search(lat, lon, true) < 0) return NaN;
		let [ids, weights] = this.locate(lat, lon) ?? [[], []];
		if (ids.some((id) => !isFinite(values[id - this.nxStart]))) {
			ids = [];
			weights = [];
		}
		if (ids.length === 0) {
			// inverse-distance weighting over the nearest finite values
			for (let i = 0; i < this.candCount && ids.length < 4; i++) {
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

	/**
	 * The cells and barycentric weights of the triangle containing a
	 * coordinate, in Web Mercator like the tiles, or undefined off the
	 * triangulation (and past the mercator limit, where triangles are flat).
	 */
	private locate(lat: number, lon: number): [number[], number[]] | undefined {
		const { triangles, mercator } = this.triangulation;
		const qx = normalizeLon(lon) / 360 + 0.5;
		const sinLat = Math.sin(degreesToRadians(lat));
		const qy = 0.5 - Math.max(-Math.PI, Math.min(Math.PI, Math.atanh(sinLat))) / (2 * Math.PI);
		// on an edge, float32 positions may leave both sides slightly negative
		const tolerance = -1e-6;
		let found: [number[], number[]] | undefined;
		this.forEachTriangleRange(lat, lon, lat, lon, (first, end) => {
			for (let t = first; t < end; t++) {
				const a = triangles[3 * t];
				const b = triangles[3 * t + 1];
				const c = triangles[3 * t + 2];
				const ax = mercator[2 * a] - Math.round(mercator[2 * a] - qx);
				const bx = mercator[2 * b] - Math.round(mercator[2 * b] - qx);
				const cx = mercator[2 * c] - Math.round(mercator[2 * c] - qx);
				const ay = mercator[2 * a + 1];
				const by = mercator[2 * b + 1];
				const cy = mercator[2 * c + 1];
				const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
				if (d === 0) continue;
				const l0 = ((by - cy) * (qx - cx) + (cx - bx) * (qy - cy)) / d;
				const l1 = ((cy - ay) * (qx - cx) + (ax - cx) * (qy - cy)) / d;
				const l2 = 1 - l0 - l1;
				if (l0 < tolerance || l1 < tolerance || l2 < tolerance) continue;
				found = [
					[a, b, c],
					[l0, l1, l2]
				];
				return false;
			}
		});
		return found;
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

	/**
	 * Visits the stored buckets touching the lat/lon box as runs [first, end)
	 * of consecutive buckets (whole bands merge), until the callback returns
	 * false.
	 */
	private forEachBucketRun(
		south: number,
		west: number,
		north: number,
		east: number,
		callback: (first: number, end: number) => void | false
	): void {
		const index = this.index;
		const b0 = Math.floor((degreesToRadians(Math.max(-90, south)) + Math.PI / 2) / this.bandHeight);
		const b1 = Math.floor((degreesToRadians(Math.min(90, north)) + Math.PI / 2) / this.bandHeight);
		const lonW = degreesToRadians(west);
		const lonE = degreesToRadians(east);
		// the pending run
		let runStart = 0;
		let runEnd = 0;
		let stopped = false;
		const add = (first: number, end: number): void => {
			if (first >= end || stopped) return;
			if (first === runEnd && runEnd > runStart) {
				runEnd = end;
				return;
			}
			if (runEnd > runStart && callback(runStart, runEnd) === false) stopped = true;
			runStart = first;
			runEnd = end;
		};
		for (let b = Math.max(b0, index.firstBand); b <= b1 && !stopped; b++) {
			const bi = b - index.firstBand;
			if (bi >= index.bands.length) break;
			const { columns, startColumn, storedColumns, firstBucket } = index.bands[bi];
			const scale = columns / (2 * Math.PI);
			const c0 = Math.floor((lonW + Math.PI) * scale);
			const length = Math.floor((lonE + Math.PI) * scale) - c0 + 1;
			if (length >= columns) {
				add(firstBucket, firstBucket + storedColumns);
				continue;
			}
			// The span's band-local columns [l0, l0 + length), wrapping past the
			// last column; the stored ones are [0, storedColumns).
			const l0 = (((c0 - startColumn) % columns) + columns) % columns;
			const wrapped = l0 + length - columns;
			if (wrapped > 0) add(firstBucket, firstBucket + Math.min(wrapped, storedColumns));
			if (l0 < storedColumns) {
				add(firstBucket + l0, firstBucket + Math.min(l0 + length, storedColumns));
			}
		}
		if (!stopped && runEnd > runStart) callback(runStart, runEnd);
	}

	/**
	 * Visits the records of every stored bucket touching the lat/lon box: the
	 * cell centres as unit vectors with their cell index.
	 */
	private forEachRecordInBox(
		south: number,
		west: number,
		north: number,
		east: number,
		callback: (x: number, y: number, z: number, id: number) => void
	): void {
		const { directory, records, ids } = this.index;
		this.forEachBucketRun(south, west, north, east, (first, end) => {
			for (let r = directory[first]; r < directory[end]; r++) {
				callback(records[4 * r], records[4 * r + 1], records[4 * r + 2], ids[4 * r + 3]);
			}
		});
	}

	/**
	 * Visits every triangle that may overlap the lat/lon box, as ranges
	 * [first, end) of the triangulation, until the callback returns false.
	 * Triangles are sorted by their lowest record and records are stored bucket
	 * by bucket, so the buckets within one longest edge of the box hold the
	 * lowest corner of every such triangle, and a run of buckets is one range.
	 */
	forEachTriangleRange(
		south: number,
		west: number,
		north: number,
		east: number,
		callback: (first: number, end: number) => void | false
	): void {
		const { triangleStart } = this.triangulation;
		const { directory } = this.index;
		const margin = radiansToDegrees(this.triangleReach);
		const poleward = Math.max(Math.abs(south), Math.abs(north)) + margin;
		const marginLon = poleward >= 90 ? 360 : margin / Math.cos(degreesToRadians(poleward));
		this.forEachBucketRun(
			south - margin,
			west - marginLon,
			north + margin,
			east + marginLon,
			(first, end) => {
				const firstTriangle = triangleStart[directory[first]];
				const endTriangle = triangleStart[directory[end]];
				if (endTriangle > firstTriangle) return callback(firstTriangle, endTriangle);
			}
		);
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

	// The grid's triangles over the tile, Gouraud-filled in pixel space
	private rasteriseLinear(
		values: Float32Array,
		x: number,
		y: number,
		z: number,
		tileSize: number,
		out: Float32Array
	): void {
		const { triangles, mercator } = this.triangulation;
		const worldPx = 2 ** z * tileSize;
		const fill = (
			ax: number,
			ay: number,
			bx: number,
			by: number,
			cx: number,
			cy: number,
			va: number,
			vb: number,
			vc: number
		) => {
			const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
			if (d === 0) return;
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
		};
		const lonL = tile2lon(x, z);
		// tile2lon normalises to [-180, 180), so the east edge of the last column wraps
		let lonR = tile2lon(x + 1, z);
		if (lonR <= lonL) lonR += 360;
		this.forEachTriangleRange(tile2lat(y + 1, z), lonL, tile2lat(y, z), lonR, (first, end) => {
			for (let t = first; t < end; t++) {
				const a = triangles[3 * t];
				const b = triangles[3 * t + 1];
				const c = triangles[3 * t + 2];
				const va = values[a - this.nxStart];
				const vb = values[b - this.nxStart];
				const vc = values[c - this.nxStart];
				if (!isFinite(va) || !isFinite(vb) || !isFinite(vc)) continue;
				const ay = mercator[2 * a + 1] * worldPx - y * tileSize;
				const by = mercator[2 * b + 1] * worldPx - y * tileSize;
				const cy = mercator[2 * c + 1] * worldPx - y * tileSize;
				if (Math.max(ay, by, cy) < 0 || Math.min(ay, by, cy) > tileSize) continue;
				// the copy of the first corner nearest the tile, the others next to it
				let ax = mercator[2 * a] * worldPx - x * tileSize;
				ax -= Math.round((ax - tileSize / 2) / worldPx) * worldPx;
				let bx = mercator[2 * b] * worldPx - x * tileSize;
				bx -= Math.round((bx - ax) / worldPx) * worldPx;
				let cx = mercator[2 * c] * worldPx - x * tileSize;
				cx -= Math.round((cx - ax) / worldPx) * worldPx;
				// a triangle across the antimeridian also shows on the far side of a
				// zoom-0 tile
				for (let shift = -worldPx; shift <= worldPx; shift += worldPx) {
					if (Math.max(ax, bx, cx) + shift < 0 || Math.min(ax, bx, cx) + shift > tileSize) continue;
					fill(ax + shift, ay, bx + shift, by, cx + shift, cy, va, vb, vc);
				}
			}
		});
	}
}
