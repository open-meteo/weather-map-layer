import { isSeamlessDomain, resolveConcreteDomain } from '../domain-helpers';

import { GridFactory } from './factory';

import type { Domain, GridData } from '../types';

/** The deepest zoom the protocol renders tiles for. */
export const MAX_TILE_ZOOM = 12;
/** The protocol renders 512 px tiles. */
const TILE_SIZE = 512;
const METRES_PER_DEGREE = 111_320;

/**
 * The grid spacing in degrees of longitude and latitude at the grid's centre.
 * Rotated lat/lon grids are spaced in degrees of their rotated system, every
 * other projection in metres; a Gaussian grid with N latitude lines has 2N
 * rows pole to pole and 4N points around the equator.
 */
export const gridSpacing = (grid: GridData, centreLat: number): { lon: number; lat: number } => {
	switch (grid.type) {
		case 'regular':
			if (grid.dx !== undefined) return { lon: Math.abs(grid.dx), lat: Math.abs(grid.dy) };
			return {
				lon: (grid.longitude[1] - grid.longitude[0]) / (grid.nx - 1),
				lat: (grid.latitude[1] - grid.latitude[0]) / (grid.ny - 1)
			};
		case 'gaussian':
			return {
				lon: 360 / (4 * grid.gaussianGridLatitudeLines),
				lat: 90 / grid.gaussianGridLatitudeLines
			};
		case 'projectedFromBounds':
			return {
				lon: (grid.longitude[1] - grid.longitude[0]) / (grid.nx - 1),
				lat: (grid.latitude[1] - grid.latitude[0]) / (grid.ny - 1)
			};
		default:
			if (grid.projection.name === 'RotatedLatLonProjection') {
				return { lon: Math.abs(grid.dx), lat: Math.abs(grid.dy) };
			}
			return {
				lon: Math.abs(grid.dx) / (METRES_PER_DEGREE * Math.cos((centreLat * Math.PI) / 180)),
				lat: Math.abs(grid.dy) / METRES_PER_DEGREE
			};
	}
};

/**
 * The first zoom at which a pixel of a 512 px Web Mercator tile is finer than
 * the grid spacing at the grid's centre, on both axes. From there on tiles
 * only interpolate between the same grid points.
 */
export const gridResolutionZoom = (grid: GridData): number => {
	const centreLat = GridFactory.create(grid, null).getCenter().lat;
	const spacing = gridSpacing(grid, centreLat);
	const cos = Math.cos((centreLat * Math.PI) / 180);
	const zLon = Math.log2(360 / (TILE_SIZE * spacing.lon));
	// A Mercator pixel spans fewer degrees of latitude the further from the equator
	const zLat = Math.log2((360 * cos) / (TILE_SIZE * spacing.lat));
	return Math.max(0, Math.ceil(Math.max(zLon, zLat)));
};

/**
 * The deepest zoom worth rendering raster tiles for: one past the resolution
 * zoom. Measured over the domains (`scripts/domain-max-zoom.ts`), tiles beyond
 * it differ from their parent tile upsampled by a map client in under 1 % of
 * the pixels, so clients can overzoom from here instead. Vector tiles are not
 * covered: arrows are laid out per tile and contours sampled per tile, so
 * those keep changing with every zoom.
 */
export const gridMaxZoom = (grid: GridData): number =>
	Math.min(MAX_TILE_ZOOM, gridResolutionZoom(grid) + 1);

/** A domain's `maxZoom`, derived from its grid when the domain does not set it. */
const concreteMaxZoom = (domain: Domain): number => domain.maxZoom ?? gridMaxZoom(domain.grid);

/**
 * The maximum zoom of a domain: a composite takes the deepest of its layers,
 * since its finest layer decides where tiles stop changing.
 */
export const domainMaxZoom = (domain: Domain, domainOptions: Domain[]): number => {
	if (!isSeamlessDomain(domain)) return concreteMaxZoom(domain);
	return Math.max(
		...domain.layers.map((layer) => {
			const concrete = resolveConcreteDomain(layer.domainValue, domainOptions);
			return concrete ? concreteMaxZoom(concrete) : 0;
		})
	);
};
