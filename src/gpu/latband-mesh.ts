/**
 * Mesh of a file-backed native ICON grid (latband.ts) for the GPU layer: the
 * grid's own triangulation (LatBandGrid.triangulation, computed once per grid
 * and shared with the CPU tiles), uploaded once and drawn with vertex
 * pulling: every triangle reads its three cells' values and the three across
 * its edges, so per fragment 'nearest' picks the closest of the six centres
 * and 'linear' interpolates barycentrically, on the same triangles as the
 * tiles. A view draws the triangle ranges around it; nothing is thinned.
 */
import type { LatBandGrid } from '../grids/latband/latband';
import type { LatBandTriangulation } from '../grids/latband/triangulation';

/** Texels per row of the mesh textures (as wide as the value textures). */
export const MESH_TEX_WIDTH = 4096;

/** What a draw needs of a native ICON grid's mesh. */
export interface LatBandMeshDraw {
	/** Uploaded once per grid, keyed by identity. */
	triangulation: LatBandTriangulation;
	/** Triangles in and around the view: (first, count) pairs. */
	ranges: number[];
}

/**
 * The triangle ranges of `grid` around the view (geographic bounds, west/east
 * unwrapped like MapLibre's getBounds), as (first, count) pairs. A view covers
 * one run of triangles per latitude band; runs closer than their own length
 * merge, trading a few off-screen triangles for fewer draw calls.
 */
export const latbandRanges = (
	grid: LatBandGrid,
	view: [west: number, south: number, east: number, north: number]
): number[] => {
	const [west, south, east, north] = view;
	const ranges: number[] = [];
	grid.forEachTriangleRange(south, west, north, east, (first, end) => {
		const last = ranges.length - 2;
		if (last >= 0) {
			const previousEnd = ranges[last] + ranges[last + 1];
			if (first - previousEnd <= Math.max(ranges[last + 1], end - first)) {
				ranges[last + 1] = end - ranges[last];
				return;
			}
		}
		ranges.push(first, end - first);
	});
	return ranges;
};
