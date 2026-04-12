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
	 * Iterates over grid points, invoking the callback with the flat array index
	 * and the geographic coordinates for each point.
	 * When `bounds` is provided, only points within the geographic bounding box
	 * are visited (implementations may use this for efficient index-range skipping).
	 * Return `false` from the callback to stop iteration early.
	 */
	forEachPoint(callback: (point: GridPoint) => void | false, bounds?: Bounds): void;
}
