import Delaunator from 'delaunator';

import type { LatBandIndex } from './latband';

// The Delaunay triangulation of a native ICON grid's cell centres (the
// LATBAND1 records), computed once per grid and shared by the CPU tiles and
// the GPU layer, so both interpolate on the same triangles at every zoom and
// nothing is thinned.
//
// - Spherical: the centres are projected stereographically from the point
//   opposite the grid (circles stay circles, so the planar Delaunay is the
//   spherical one, with no seam at the antimeridian). On a global grid that
//   point is the south pole, inside the mesh: the triangles around it (the
//   planar hull) are closed with a fan.
// - Sorted by their lowest record index: records are stored bucket by bucket,
//   band by band, so the triangles of a run of buckets form one contiguous
//   range (`triangleStart`), which is how a tile or a view finds them. The
//   corners themselves are cell indices, like the values they look up.
// - Bounded: a limited-area grid's planar hull bridges the bays of its
//   outline with slivers up to hundreds of cells long. Every triangle with an
//   edge longer than `maxEdge` is dropped; with maxEdge = sqrt(3) x the
//   acceptance radius, each kept triangle lies within the acceptance radius of
//   its corners, and a triangle reaching into a box has its lowest corner
//   within maxEdge of it. (A global mesh is closed and keeps all.)
// - `neighbours` holds, per edge, the corner opposite it in the adjacent
//   triangle (the triangle's own opposite corner on the boundary): the nearest
//   centre to a point in a triangle lies among its corners and these.
// - Drawn in Web Mercator, where tiles and the GPU layer interpolate
//   barycentrically: `mercator` holds every centre's position once.

export interface LatBandTriangulation {
	/** Cell indices, three per triangle, sorted by the lowest record of the three. */
	triangles: Uint32Array;
	/** Per edge (corner k to corner k + 1), the far corner of the adjacent triangle. */
	neighbours: Uint32Array;
	/** First triangle whose lowest corner is record r or later; count + 1 entries. */
	triangleStart: Uint32Array;
	/** Per cell: Web Mercator x in (0, 1] and y in [0, 1] (clamped at the poles). */
	mercator: Float32Array;
}

export type BufferConstructor = new (byteLength: number) => ArrayBufferLike;

const next = (e: number): number => (e % 3 === 2 ? e - 2 : e + 1);

/**
 * Triangulates the centres of a parsed LATBAND1 index, dropping triangles
 * with an edge longer than `maxEdge` (radians) on a limited-area grid.
 * `Buffer` backs the result (a SharedArrayBuffer lets every tile worker use
 * one copy).
 */
export const triangulateLatBand = (
	index: LatBandIndex,
	maxEdge: number,
	Buffer: BufferConstructor = ArrayBuffer
): LatBandTriangulation => {
	const { count, records, ids } = index;

	// Projection pole: opposite the grid's mean direction, or the south pole
	// for a global grid (whose mean is about zero). No centre lies on it.
	let px = 0;
	let py = 0;
	let pz = -1;
	if (!index.global) {
		let sx = 0;
		let sy = 0;
		let sz = 0;
		for (let r = 0; r < count; r++) {
			sx += records[4 * r];
			sy += records[4 * r + 1];
			sz += records[4 * r + 2];
		}
		const norm = Math.hypot(sx, sy, sz);
		px = -sx / norm;
		py = -sy / norm;
		pz = -sz / norm;
	}
	// Orthonormal basis of the plane perpendicular to the pole.
	const [ax, ay, az] = Math.abs(pz) < 0.9 ? [0, 0, 1] : [1, 0, 0];
	let e1x = py * az - pz * ay;
	let e1y = pz * ax - px * az;
	let e1z = px * ay - py * ax;
	const e1n = Math.hypot(e1x, e1y, e1z);
	e1x /= e1n;
	e1y /= e1n;
	e1z /= e1n;
	const e2x = py * e1z - pz * e1y;
	const e2y = pz * e1x - px * e1z;
	const e2z = px * e1y - py * e1x;

	const coords = new Float64Array(2 * count);
	for (let r = 0; r < count; r++) {
		const x = records[4 * r];
		const y = records[4 * r + 1];
		const z = records[4 * r + 2];
		const k = 1 / (1 - (x * px + y * py + z * pz));
		coords[2 * r] = (x * e1x + y * e1y + z * e1z) * k;
		coords[2 * r + 1] = (x * e2x + y * e2y + z * e2z) * k;
	}
	const delaunay = new Delaunator(coords);
	const tri = delaunay.triangles;
	const half = delaunay.halfedges;
	const hull = delaunay.hull;
	const delaunayCount = tri.length / 3;

	// The slivers of a limited-area grid's hull.
	const keep = new Uint8Array(delaunayCount).fill(1);
	if (!index.global) {
		const maxChord2 = 4 * Math.sin(Math.min(Math.PI, maxEdge) / 2) ** 2;
		const chord2 = (a: number, b: number): number =>
			(records[4 * a] - records[4 * b]) ** 2 +
			(records[4 * a + 1] - records[4 * b + 1]) ** 2 +
			(records[4 * a + 2] - records[4 * b + 2]) ** 2;
		for (let t = 0; t < delaunayCount; t++) {
			const a = tri[3 * t];
			const b = tri[3 * t + 1];
			const c = tri[3 * t + 2];
			if (chord2(a, b) > maxChord2 || chord2(b, c) > maxChord2 || chord2(c, a) > maxChord2) {
				keep[t] = 0;
			}
		}
	}

	// A global grid's hull rings the projection pole: fan it closed. Ring edge
	// (hull[j], hull[j + 1]) is shared by a Delaunay and a fan triangle.
	const fanCount = index.global && hull.length >= 3 ? hull.length - 2 : 0;
	let total = fanCount;
	for (let t = 0; t < delaunayCount; t++) total += keep[t];
	const kept = new Uint32Array(total);
	for (let t = 0, i = 0; t < delaunayCount + fanCount; t++) {
		if (t >= delaunayCount || keep[t]) kept[i++] = t;
	}
	const edgeKey = (a: number, b: number): number => (a < b ? a * count + b : b * count + a);
	// Ring edge -> far corner on the Delaunay side and on the fan side.
	const ringDelaunay = new Map<number, number>();
	const ringFan = new Map<number, number>();
	if (fanCount > 0) {
		for (let e = 0; e < tri.length; e++) {
			if (half[e] < 0) ringDelaunay.set(edgeKey(tri[e], tri[next(e)]), tri[next(next(e))]);
		}
		const h = hull.length;
		for (let j = 0; j < h; j++) {
			const a = hull[j];
			const b = hull[(j + 1) % h];
			// The fan triangle (hull[0], hull[i + 1], hull[i + 2]) holding this edge.
			const far = j === 0 ? hull[2] : j === h - 1 ? hull[h - 2] : hull[0];
			ringFan.set(edgeKey(a, b), far);
		}
	}

	// The fan's corners and neighbours; the Delaunay part is read in place.
	const fan = new Uint32Array(3 * fanCount);
	const fanNeighbours = new Uint32Array(3 * fanCount);
	for (let i = 0; i < fanCount; i++) {
		const a = hull[0];
		const b = hull[i + 1];
		const c = hull[i + 2];
		fan.set([a, b, c], 3 * i);
		// Edge a-b: the previous fan triangle, or the Delaunay side on the ring.
		fanNeighbours[3 * i] = i > 0 ? hull[i] : ringDelaunay.get(edgeKey(a, b))!;
		fanNeighbours[3 * i + 1] = ringDelaunay.get(edgeKey(b, c))!;
		fanNeighbours[3 * i + 2] = i < fanCount - 1 ? hull[i + 3] : ringDelaunay.get(edgeKey(c, a))!;
	}
	const corner = (t: number, k: number): number =>
		t < delaunayCount ? tri[3 * t + k] : fan[3 * (t - delaunayCount) + k];
	const neighbour = (t: number, k: number): number => {
		if (t >= delaunayCount) return fanNeighbours[3 * (t - delaunayCount) + k];
		const e = 3 * t + k;
		const twin = half[e];
		if (twin >= 0 && keep[Math.floor(twin / 3)]) return tri[next(next(twin))];
		// Boundary edge: the fan's corner across it, or the own opposite corner.
		return ringFan.get(edgeKey(tri[e], tri[next(e)])) ?? tri[next(next(e))];
	};

	// Counting sort by the lowest corner.
	const triangleStart = new Uint32Array(new Buffer(4 * (count + 1)));
	const lowest = new Uint32Array(total);
	for (let i = 0; i < total; i++) {
		const a = corner(kept[i], 0);
		const b = corner(kept[i], 1);
		const c = corner(kept[i], 2);
		lowest[i] = a < b ? (a < c ? a : c) : b < c ? b : c;
		triangleStart[lowest[i] + 1]++;
	}
	for (let r = 0; r < count; r++) triangleStart[r + 1] += triangleStart[r];
	const cursor = triangleStart.slice(0, count);
	const triangles = new Uint32Array(new Buffer(12 * total));
	const neighbours = new Uint32Array(new Buffer(12 * total));
	for (let i = 0; i < total; i++) {
		const s = cursor[lowest[i]]++;
		for (let k = 0; k < 3; k++) {
			triangles[3 * s + k] = ids[4 * corner(kept[i], k) + 3];
			neighbours[3 * s + k] = ids[4 * neighbour(kept[i], k) + 3];
		}
	}

	const mercator = new Float32Array(new Buffer(8 * count));
	for (let r = 0; r < count; r++) {
		const id = ids[4 * r + 3];
		const y = Math.max(-Math.PI, Math.min(Math.PI, Math.atanh(records[4 * r + 2])));
		mercator[2 * id] = Math.atan2(records[4 * r + 1], records[4 * r]) / (2 * Math.PI) + 0.5;
		mercator[2 * id + 1] = 0.5 - y / (2 * Math.PI);
	}
	return { triangles, neighbours, triangleStart, mercator };
};
