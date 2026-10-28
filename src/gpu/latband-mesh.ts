/**
 * Mesh of a file-backed native ICON grid (latband.ts) for the GPU layer: the
 * cell centres in and around the view, Delaunay-triangulated in mercator
 * space — the dual mesh the CPU tiles interpolate on (LatBandGrid
 * rasteriseLinear). The raster pass draws it with vertex pulling: every
 * triangle reads its three cells' values, so per fragment 'nearest' picks the
 * closest of the three centres and 'linear' interpolates barycentrically.
 *
 * Meshed per view, like the CPU path meshes per tile: the cell order is the
 * model's, and a whole global grid would be millions of triangles. A dense
 * view is thinned to a point budget first (sub-pixel cells look the same),
 * which widens the radius a coordinate may lie from its centre by the same
 * factor.
 */
import type { LatBandGrid } from '../grids/latband/latband';
import { lat2tile } from '../utils/math';
import Delaunator from 'delaunator';

const MERCATOR_LAT_LIMIT = 85.0511;
/** Share of the view's span meshed beyond each edge, so a pan has data. */
const VIEW_MARGIN = 0.15;
/**
 * Texels per row of the mesh textures; the arrays come padded to whole rows
 * so they upload as they are.
 */
export const MESH_TEX_WIDTH = 2048;

const padToRows = (texels: number): number =>
	Math.max(1, Math.ceil(texels / MESH_TEX_WIDTH)) * MESH_TEX_WIDTH;

export interface LatBandMesh {
	/** Per point: mercator x (unwrapped around the view), mercator y, cell index, 0. */
	points: Float32Array;
	pointCount: number;
	/** Point indices, three per triangle. */
	triangles: Uint32Array;
	/**
	 * Per triangle, the point across each edge (the far corner of the
	 * neighbour; the triangle's own opposite corner on the hull): the nearest
	 * centre is one of these six, not only the three corners. ICON's centres
	 * lie in near-cocircular hexagons around the grid vertices, which the
	 * Delaunay splits arbitrarily, so a third corner is often not the nearest.
	 */
	neighbours: Uint32Array;
	triangleCount: number;
	/**
	 * Radius (radians) around a centre within which a coordinate belongs to
	 * its cell: 1.5 cell spacings like the CPU lookup, widened by the thinning.
	 */
	acceptRadius: number;
	/** Mercator box the mesh covers, [x0, y0, x1, y1] with x unwrapped. */
	coverage: [number, number, number, number];
	/** Covers a whole world in x (zoomed far out): drawn once per world copy. */
	wholeWorld: boolean;
	/** The point budget the mesh was thinned to. */
	maxPoints: number;
}

/**
 * Triangulates the centres of `grid` in the view (geographic bounds, west/east
 * unwrapped like MapLibre's getBounds) plus a margin, thinned to `maxPoints`.
 * Undefined when fewer than three centres lie in view.
 */
export const buildLatBandMesh = (
	grid: LatBandGrid,
	view: [west: number, south: number, east: number, north: number],
	maxPoints: number
): LatBandMesh | undefined => {
	const [west, south, east, north] = view;
	const marginLon = (east - west) * VIEW_MARGIN;
	const marginLat = (north - south) * VIEW_MARGIN;
	const wholeWorld = east - west + 2 * marginLon >= 360;
	// Mercator x is unwrapped into one world centred on the view, so the mesh
	// stays contiguous across the antimeridian.
	const centreX = (west + east) / 2 / 360 + 0.5;
	const x0 = wholeWorld ? centreX - 0.5 : (west - marginLon) / 360 + 0.5;
	const x1 = wholeWorld ? centreX + 0.5 : (east + marginLon) / 360 + 0.5;
	const latSouth = Math.max(-90, south - marginLat);
	const latNorth = Math.min(90, north + marginLat);

	const xs: number[] = [];
	const ys: number[] = [];
	const ids: number[] = [];
	const addPoint = (x: number, y: number, id: number): void => {
		xs.push(x);
		ys.push(y);
		ids.push(id);
	};
	grid.forEachRecordInBox(
		latSouth,
		wholeWorld ? -180 : west - marginLon,
		latNorth,
		wholeWorld ? 180 : east + marginLon,
		(cx, cy, cz, id) => {
			const lat = (Math.asin(Math.max(-1, Math.min(1, cz))) * 180) / Math.PI;
			const lon = (Math.atan2(cy, cx) * 180) / Math.PI;
			let x = (lon + 180) / 360;
			x -= Math.floor(x - centreX + 0.5);
			const y = lat2tile(Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat)), 0);
			addPoint(x, y, id);
			// A whole-world mesh repeats the centres along its seam one world
			// over, so triangles close the gap between the copies.
			if (wholeWorld) {
				if (x - x0 < 0.02) addPoint(x + 1, y, id);
				else if (x1 - x < 0.02) addPoint(x - 1, y, id);
			}
		}
	);

	let count = ids.length;
	if (count < 3) return undefined;
	// Thin by stride over the bucket order (band-major, so the kept centres
	// spread evenly), like the CPU tile path's decimation.
	const stride = Math.max(1, Math.ceil(count / maxPoints));
	if (stride > 1) {
		let kept = 0;
		for (let i = 0; i < count; i += stride) {
			xs[kept] = xs[i];
			ys[kept] = ys[i];
			ids[kept] = ids[i];
			kept++;
		}
		count = kept;
	}

	const coords = new Float64Array(2 * count);
	for (let i = 0; i < count; i++) {
		coords[2 * i] = xs[i];
		coords[2 * i + 1] = ys[i];
	}
	const delaunay = new Delaunator(coords);
	const triangleCount = delaunay.triangles.length / 3;
	if (triangleCount === 0) return undefined;
	const triangles = new Uint32Array(3 * padToRows(triangleCount));
	triangles.set(delaunay.triangles);
	// Half-edge e runs from corner e to corner next(e); its twin's triangle
	// has the far point at the twin's previous half-edge.
	const neighbours = new Uint32Array(triangles.length);
	const next = (e: number): number => (e % 3 === 2 ? e - 2 : e + 1);
	for (let e = 0; e < 3 * triangleCount; e++) {
		const twin = delaunay.halfedges[e];
		neighbours[e] = delaunay.triangles[twin < 0 ? next(next(e)) : next(next(twin))];
	}

	const points = new Float32Array(4 * padToRows(count));
	for (let i = 0; i < count; i++) {
		points[4 * i] = xs[i];
		points[4 * i + 1] = ys[i];
		// Cell indices stay below 2^24, exact in a float.
		points[4 * i + 2] = ids[i];
	}
	return {
		points,
		pointCount: count,
		triangles,
		neighbours,
		triangleCount,
		acceptRadius: 1.5 * grid.spacing * Math.sqrt(stride),
		coverage: [
			x0,
			lat2tile(Math.min(latNorth, MERCATOR_LAT_LIMIT), 0),
			x1,
			lat2tile(Math.max(latSouth, -MERCATOR_LAT_LIMIT), 0)
		],
		wholeWorld,
		maxPoints
	};
};
