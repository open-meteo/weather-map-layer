import { Bounds, DimensionRange, InterpolationMethod } from '../types';

export interface GridPoint {
	index: number; // Index into the flat values array
	lat: number;
	lon: number;
}

export interface GridInterface {
	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number;

	/**
	 * Samples an angular field in degrees with circular linear interpolation, so
	 * values blend across the 0°/360° seam (halfway between 359° and 1° is 0°,
	 * not the 180° scalar interpolation would give). Returns degrees in [0, 360).
	 */
	getLinearInterpolatedDirection(values: Float32Array, lat: number, lon: number): number;

	/**
	 * Samples the grid at the given geographic coordinate using the requested
	 * interpolation method.
	 */
	getInterpolatedValue(
		values: Float32Array,
		lat: number,
		lon: number,
		method: InterpolationMethod
	): number;

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
	 * Outline of the grid cell at a coordinate as a closed `[lon, lat]` ring
	 * (first point repeated at the end), or null outside the grid. The cell is
	 * the area over which nearest-neighbour sampling reads the same grid node as
	 * at the coordinate, so it is the patch one value colours and always
	 * contains the coordinate. Longitudes are continuous with `lon`, so a cell
	 * on the antimeridian keeps its shape instead of wrapping.
	 */
	getCellPolygon(lat: number, lon: number): Array<[number, number]> | null;

	/**
	 * Iterates over grid points, invoking the callback with the flat array index
	 * and the geographic coordinates for each point.
	 * When `bounds` is provided, only points within the geographic bounding box
	 * are visited (implementations may use this for efficient index-range skipping).
	 * Return `false` from the callback to stop iteration early.
	 */
	forEachPoint(callback: (point: GridPoint) => void | false, bounds?: Bounds): void;
}
