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
	 * Optional fast path: rasterise the grid's native cells directly into a
	 * mercator tile (forward, cell → pixels) instead of sampling per pixel.
	 * Returns a `tileSize²` row-major value buffer (NaN where uncovered). Grids
	 * that implement it (the native ICON triangular grid) render far faster and
	 * keep exact cell boundaries; the worker falls back to per-pixel
	 * `getInterpolatedValue` when it is absent.
	 */
	renderTile?(
		values: Float32Array,
		x: number,
		y: number,
		z: number,
		tileSize: number,
		method: InterpolationMethod
	): Float32Array;

	/**
	 * Returns the grid's outline as a closed `[lon, lat]` ring (first point repeated
	 * at the end). Projected grids return the true perimeter traced through the
	 * projection (a curved polygon in lon/lat); regular and gaussian grids return
	 * their axis-aligned bounds rectangle.
	 */
	getBoundaryPolygon(): Array<[number, number]>;

	/**
	 * Iterates over grid points, invoking the callback with the flat array index
	 * and the geographic coordinates for each point.
	 * When `bounds` is provided, only points within the geographic bounding box
	 * are visited (implementations may use this for efficient index-range skipping).
	 * Return `false` from the callback to stop iteration early.
	 */
	forEachPoint(callback: (point: GridPoint) => void | false, bounds?: Bounds): void;
}
