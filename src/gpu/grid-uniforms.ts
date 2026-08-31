/**
 * Turns a serialisable grid definition (`GridData` + dimension ranges) into the
 * uniform values the GPU shaders need. This mirrors the constructors of
 * `RegularGrid`, `ProjectionGrid` and `GaussianGrid` — the projection constants
 * are computed by instantiating the existing CPU projection classes and reading
 * their precomputed fields, so both paths share one source of truth.
 */
import { GridFactory } from '../grids/index';
import {
	LambertAzimuthalEqualAreaProjection,
	LambertConformalConicProjection,
	RotatedLatLonProjection,
	StereographicProjection,
	createProjection
} from '../grids/projections';
import { lat2tile, lon2tile } from '../utils/math';

import type { LayerShaderSpec } from './shader-source';

import type { Bounds, DimensionRange, GridData } from '../types';

/** Web-mercator latitude limit; regular grids may extend to the poles. */
const MERCATOR_LAT_LIMIT = 85.051129;

/** Width of the 2D texture the flat gaussian value array is packed into. */
export const GAUSSIAN_TEX_WIDTH = 4096;

export interface GpuGridUniforms {
	gridKind: LayerShaderSpec['gridKind'];
	projectionName?: LayerShaderSpec['projectionName'];
	/** Dimensions of the value texture (grid nx/ny; packed rows for gaussian). */
	nx: number;
	ny: number;
	/** Regular: lon/lat of grid index [0,0]. Projected: minX/minY in projection space. */
	originX: number;
	originY: number;
	/** Regular: degrees per step (signed). Projected: projection units per step (signed). */
	dx: number;
	dy: number;
	lonWrap: boolean;
	wrapLastCellDouble: boolean;
	/** Packed projection constants, layout depends on projectionName (see shader-source.ts). */
	projA: [number, number, number, number];
	projB: [number, number, number, number];
	/** Gaussian: (latitudeLines, nxStart, texWidth, texelCount). */
	gauss: [number, number, number, number];
	/** Full-domain geographic bounds (not viewport-cropped), for edge blending. */
	fullBounds: Bounds;
	/** Projected grids: full-grid edge parameters for the blend distance. */
	edgeProj?: {
		minX: number;
		minY: number;
		/** nx - 1 / ny - 1 of the full grid. */
		nxM1: number;
		nyM1: number;
		degPerCol: number;
		degPerRow: number;
	};
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
	const r = ranges ?? fullRanges(grid);
	// Reuses the CPU grids for bounds so cropped (ranges) grids and projected
	// perimeters are handled identically to the raster/vector tile paths.
	const bounds = GridFactory.create(grid, r).getBounds();
	const fullBounds = GridFactory.create(grid, null).getBounds();
	const quad = boundsToMercatorQuad(bounds);

	switch (grid.type) {
		case 'regular':
			return regularUniforms(grid, r, fullBounds, quad);
		case 'projectedFromBounds':
		case 'projectedFromProjectedOrigin':
		case 'projectedFromGeographicOrigin':
			return projectedUniforms(grid, r, fullBounds, quad);
		case 'gaussian':
			return gaussianUniforms(grid, r, fullBounds, quad);
		default: {
			// This ensures exhaustiveness checking
			const _exhaustive: never = grid;
			throw new Error(`Unknown grid type: ${_exhaustive}`);
		}
	}
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

const baseUniforms = (
	fullBounds: Bounds,
	quad: [number, number, number, number]
): Pick<
	GpuGridUniforms,
	'projA' | 'projB' | 'gauss' | 'lonWrap' | 'wrapLastCellDouble' | 'fullBounds' | 'quad'
> => ({
	projA: [0, 0, 0, 0],
	projB: [0, 0, 0, 0],
	gauss: [0, 0, 0, 0],
	lonWrap: false,
	wrapLastCellDouble: false,
	fullBounds,
	quad
});

const regularUniforms = (
	grid: Extract<GridData, { type: 'regular' }>,
	ranges: DimensionRange[],
	fullBounds: Bounds,
	quad: [number, number, number, number]
): GpuGridUniforms => {
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

	const nx = ranges[1].end - ranges[1].start;
	const ny = ranges[0].end - ranges[0].start;

	const absDx = Math.abs(dx);
	const lonSpan = nx * absDx;
	const lonWrap = lonSpan >= 360 - 1.5 * absDx;

	return {
		...baseUniforms(fullBounds, quad),
		gridKind: 'regular',
		nx,
		ny,
		originX: originLon + dx * ranges[1].start,
		originY: originLat + dy * ranges[0].start,
		dx,
		dy,
		lonWrap,
		wrapLastCellDouble: lonWrap && lonSpan < 360 - 0.5 * absDx
	};
};

const projectedUniforms = (
	grid: Extract<
		GridData,
		{
			type:
				'projectedFromBounds' | 'projectedFromProjectedOrigin' | 'projectedFromGeographicOrigin';
		}
	>,
	ranges: DimensionRange[],
	fullBounds: Bounds,
	quad: [number, number, number, number]
): GpuGridUniforms => {
	// Mirror of the ProjectionGrid constructor (grids/projected.ts).
	const projection = createProjection(grid.projection);

	let origin: [number, number];
	let dx: number;
	let dy: number;
	switch (grid.type) {
		case 'projectedFromBounds': {
			const sw = projection.forward(grid.latitude[0], grid.longitude[0]);
			const ne = projection.forward(grid.latitude[1], grid.longitude[1]);
			origin = sw;
			dx = (ne[0] - sw[0]) / (grid.nx - 1);
			dy = (ne[1] - sw[1]) / (grid.ny - 1);
			break;
		}
		case 'projectedFromGeographicOrigin': {
			origin = projection.forward(grid.latitude, grid.longitude);
			dx = grid.dx;
			dy = grid.dy;
			break;
		}
		case 'projectedFromProjectedOrigin': {
			origin = [grid.longitudeProjectionOrigin, grid.latitudeProjectionOrigin];
			dx = grid.dx;
			dy = grid.dy;
			break;
		}
	}

	const nx = ranges[1].end - ranges[1].start;
	const ny = ranges[0].end - ranges[0].start;

	let projA: [number, number, number, number];
	let projB: [number, number, number, number] = [0, 0, 0, 0];
	if (projection instanceof RotatedLatLonProjection) {
		projA = [projection.cosθ, projection.sinθ, projection.cosϕ, projection.sinϕ];
	} else if (projection instanceof LambertConformalConicProjection) {
		projA = [projection.λ0, projection.n, projection.F, projection.ρ0];
		projB = [projection.R, 0, 0, 0];
	} else if (projection instanceof LambertAzimuthalEqualAreaProjection) {
		projA = [projection.λ0, projection.sinϕ1, projection.cosϕ1, projection.R];
	} else if (projection instanceof StereographicProjection) {
		projA = [projection.λ0, projection.sinϕ1, projection.cosϕ1, projection.R];
	} else {
		throw new Error(`gpu: unsupported projection '${grid.projection.name}'`);
	}

	// Full-grid edge parameters (port of ProjectionGrid.edgeDistanceDeg).
	const [minLon, minLat, maxLon, maxLat] = fullBounds;
	const edgeProj = {
		minX: origin[0],
		minY: origin[1],
		nxM1: grid.nx - 1,
		nyM1: grid.ny - 1,
		degPerCol: (maxLon - minLon) / (grid.nx - 1),
		degPerRow: (maxLat - minLat) / (grid.ny - 1)
	};

	return {
		...baseUniforms(fullBounds, quad),
		gridKind: 'projected',
		projectionName: grid.projection.name,
		nx,
		ny,
		originX: origin[0] + dx * ranges[1].start,
		originY: origin[1] + dy * ranges[0].start,
		dx,
		dy,
		projA,
		projB,
		edgeProj
	};
};

const gaussianUniforms = (
	grid: Extract<GridData, { type: 'gaussian' }>,
	ranges: DimensionRange[],
	fullBounds: Bounds,
	quad: [number, number, number, number]
): GpuGridUniforms => {
	// Mirror of the GaussianGrid constructor (grids/gaussian.ts): the flat value
	// array (possibly a partial nxStart..end slice) is packed row-major into a
	// GAUSSIAN_TEX_WIDTH-wide 2D texture.
	const nxStart = ranges[1].start;
	const valueCount = ranges[1].end - ranges[1].start;
	const texWidth = GAUSSIAN_TEX_WIDTH;
	const texHeight = Math.max(1, Math.ceil(valueCount / texWidth));

	return {
		...baseUniforms(fullBounds, quad),
		gridKind: 'gaussian',
		nx: texWidth,
		ny: texHeight,
		originX: 0,
		originY: 0,
		dx: 0,
		dy: 0,
		gauss: [grid.gaussianGridLatitudeLines, nxStart, texWidth, texWidth * texHeight]
	};
};
