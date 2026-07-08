import { SummedAreaTable } from './area-average';

import { Bounds, DimensionRange, InterpolationMethod } from '../types';

export interface GridPoint {
	index: number; // Index into the flat values array
	lat: number;
	lon: number;
}

export interface GridInterface {
	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number;

	/**
	 * Samples the grid at the given geographic coordinate using the requested
	 * interpolation method. `smoothFootprint` is the box half-width in grid
	 * cells used only by the 'smooth' (area-average) method.
	 */
	getInterpolatedValue(
		values: Float32Array,
		lat: number,
		lon: number,
		method: InterpolationMethod,
		smoothFootprint?: number
	): number;

	/**
	 * Injects a pre-built summed-area table for the 'smooth' method, so tile
	 * renders reuse one shared (SharedArrayBuffer-backed) build instead of each
	 * rebuilding it. `source` is the values array the table was built from; a
	 * later call with a different array still triggers a lazy rebuild. Absent on
	 * grids without a rectangular layout (e.g. reduced Gaussian).
	 */
	setSummedAreaTable?(sat: SummedAreaTable, source: Float32Array): void;

	getBounds(): Bounds;
	getCenter(): { lng: number; lat: number };
	getCoveringRanges(south: number, west: number, north: number, east: number): DimensionRange[];

	/**
	 * Iterates over grid points, invoking the callback with the flat array index
	 * and the geographic coordinates for each point.
	 * When `bounds` is provided, only points within the geographic bounding box
	 * are visited (implementations may use this for efficient index-range skipping).
	 * Return `false` from the callback to stop iteration early.
	 */
	forEachPoint(callback: (point: GridPoint) => void | false, bounds?: Bounds): void;
}
