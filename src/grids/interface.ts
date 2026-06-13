import { Bounds, DimensionRange } from '../types';

export interface GridPoint {
	index: number; // Index into the flat values array
	lat: number;
	lon: number;
}

export interface GridInterface {
	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number;

	getBounds(): Bounds;
	getCenter(): { lng: number; lat: number };
	getCoveringRanges(south: number, west: number, north: number, east: number): DimensionRange[];

	/**
	 * Returns the grid's outline as a closed `[lon, lat]` ring (first point repeated
	 * at the end). Projected grids return the true perimeter traced through the
	 * projection (a curved polygon in lon/lat); regular and gaussian grids return
	 * their axis-aligned bounds rectangle.
	 */
	getBoundaryPolygon(): Array<[number, number]>;

	/**
	 * Approximate distance (in degrees, positive inside) from (lat, lon) to the
	 * nearest edge of the grid's actual data region. For projected grids this is
	 * measured in projection space, so the seamless blend zone follows the true
	 * (curved) domain boundary instead of an axis-aligned lat/lon box. Regular and
	 * gaussian grids return the distance to their bounds rectangle.
	 */
	edgeDistanceDeg(lat: number, lon: number): number;

	/**
	 * Iterates over grid points, invoking the callback with the flat array index
	 * and the geographic coordinates for each point.
	 * When `bounds` is provided, only points within the geographic bounding box
	 * are visited (implementations may use this for efficient index-range skipping).
	 * Return `false` from the callback to stop iteration early.
	 */
	forEachPoint(callback: (point: GridPoint) => void | false, bounds?: Bounds): void;
}
