/**
 * Turns a serialisable regular grid definition (`GridData` + dimension ranges)
 * into the uniform values the GPU shader needs. This mirrors the constructor
 * of `RegularGrid` (grids/regular.ts); the geographic bounds come from
 * instantiating that CPU class, so both paths share one source of truth.
 */
import { GridFactory } from '../grids/index';
import { lat2tile, lon2tile } from '../utils/math';

import type { Bounds, DimensionRange, GridData } from '../types';

/** Web-mercator latitude limit; regular grids may extend to the poles. */
const MERCATOR_LAT_LIMIT = 85.051129;

export interface GpuGridUniforms {
	/** Dimensions of the value texture (grid nx/ny of the loaded crop). */
	nx: number;
	ny: number;
	/** Lon/lat of grid index [0,0]. */
	originX: number;
	originY: number;
	/** Degrees per step (signed). */
	dx: number;
	dy: number;
	lonWrap: boolean;
	wrapLastCellDouble: boolean;
	/** Quad covering the grid in mercator [0..1] space: x0/y0 top-left, x1/y1 bottom-right. */
	quad: [x0: number, y0: number, x1: number, y1: number];
}

const fullRanges = (grid: GridData): DimensionRange[] => [
	{ start: 0, end: grid.ny },
	{ start: 0, end: grid.nx }
];

export const computeGridUniforms = (
	grid: GridData,
	ranges: DimensionRange[] | null
): GpuGridUniforms => {
	if (grid.type !== 'regular') {
		throw new Error(
			`gpu: unsupported grid type '${grid.type}' (only regular lat/lon grids render on the GPU)`
		);
	}
	const r = ranges ?? fullRanges(grid);
	// Reuses the CPU grid for bounds so cropped (ranges) grids are handled
	// identically to the raster/vector tile paths.
	const bounds = GridFactory.create(grid, r).getBounds();
	const quad = boundsToMercatorQuad(bounds);

	// Mirror of the RegularGrid constructor (grids/regular.ts).
	let originLon: number;
	let originLat: number;
	let dx: number;
	let dy: number;
	if (grid.latitude && grid.longitude) {
		originLon = grid.longitude[0];
		originLat = grid.latitude[0];
		dx = (grid.longitude[1] - grid.longitude[0]) / (grid.nx - 1);
		dy = (grid.latitude[1] - grid.latitude[0]) / (grid.ny - 1);
	} else {
		originLon = grid.lonMin;
		originLat = grid.latMin;
		dx = grid.dx;
		dy = grid.dy;
	}

	const nx = r[1].end - r[1].start;
	const ny = r[0].end - r[0].start;

	const absDx = Math.abs(dx);
	const lonSpan = nx * absDx;
	const lonWrap = lonSpan >= 360 - 1.5 * absDx;

	// A wrapping grid tiles the whole circle: extend the quad to exactly one
	// world so adjacent world copies meet without a gap. Grids whose data span
	// is short of 360° (double-width wrap cell, e.g. ICON) would otherwise
	// leave a bare strip at the antimeridian.
	const quadFull: typeof quad = lonWrap ? [quad[0], quad[1], quad[0] + 1, quad[3]] : quad;

	return {
		nx,
		ny,
		originX: originLon + dx * r[1].start,
		originY: originLat + dy * r[0].start,
		dx,
		dy,
		lonWrap,
		wrapLastCellDouble: lonWrap && lonSpan < 360 - 0.5 * absDx,
		quad: quadFull
	};
};

/** Geographic bounds as a mercator-space quad (natural lon direction, top edge first). */
const boundsToMercatorQuad = (bounds: Bounds): [number, number, number, number] => {
	const [west, south, east, north] = bounds;
	const northClamped = Math.min(north, MERCATOR_LAT_LIMIT);
	const southClamped = Math.max(south, -MERCATOR_LAT_LIMIT);
	return [
		lon2tile(west, 0),
		lat2tile(northClamped, 0), // top edge first: mercator y grows southwards
		lon2tile(east, 0),
		lat2tile(southClamped, 0)
	];
};
