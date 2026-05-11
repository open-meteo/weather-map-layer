import { GridInterface, GridPoint } from './interface';
import { interpolateLinear } from './interpolations';

import { Bounds, DimensionRange, RegularGridData } from '../types';

// Regular grid implementation
export class RegularGrid implements GridInterface {
	private nx: number;
	private ny: number;
	private dx: number;
	private dy: number;

	// Coordinates at grid index [0, 0]
	private originLon: number;
	private originLat: number;

	// Bounds: [west, south, east, north]
	private bounds: Bounds;
	private longitudeWrap: boolean;
	private center?: { lng: number; lat: number };

	constructor(data: RegularGridData, ranges: DimensionRange[] | null = null) {
		this.dx = data.dx;
		this.dy = data.dy;

		if (!ranges) {
			// if ranges are not provided, use the full grid dimensions
			ranges = [
				{ start: 0, end: data.ny },
				{ start: 0, end: data.nx }
			];
		} else {
			// check that we don't exceed the grid dimensions
			if (
				ranges[0].start < 0 ||
				ranges[0].start > data.ny ||
				ranges[0].end < 0 ||
				ranges[0].end > data.ny
			) {
				throw new Error('Invalid y range');
			}
			if (
				ranges[1].start < 0 ||
				ranges[1].start > data.nx ||
				ranges[1].end < 0 ||
				ranges[1].end > data.nx
			) {
				throw new Error('Invalid x range');
			}
		}

		this.nx = ranges[1].end - ranges[1].start;
		this.ny = ranges[0].end - ranges[0].start;

		// Origin = coordinates at grid index [0, 0] of this (sub)grid
		this.originLon = data.lonMin + this.dx * ranges[1].start;
		this.originLat = data.latMin + this.dy * ranges[0].start;

		// End = coordinates one step past the last grid index
		const endLon = data.lonMin + this.dx * ranges[1].end;
		const endLat = data.latMin + this.dy * ranges[0].end;

		// Bounds: [west, south, east, north]
		// Longitude preserves natural direction for antimeridian support
		// Latitude is always ordered south <= north
		const west = this.dx >= 0 ? this.originLon : endLon;
		const east = this.dx >= 0 ? endLon : this.originLon;
		const south = this.dy >= 0 ? this.originLat : endLat;
		const north = this.dy >= 0 ? endLat : this.originLat;
		this.bounds = [west, south, east, north];
		console.log(this.bounds);

		// icon global is one grid point short, therefore compare to 359.875
		this.longitudeWrap = Math.abs(this.nx * this.dx) >= 359.875;
	}

	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number {
		// Compute floating-point grid indices from origin
		const xRaw = (lon - this.originLon) / this.dx;
		const yRaw = (lat - this.originLat) / this.dy;

		// Check y bounds (works for both positive and negative dy)
		if (yRaw < 0 || yRaw >= this.ny) {
			return NaN;
		}

		// Check x bounds
		if (!this.longitudeWrap) {
			if (xRaw < 0 || xRaw >= this.nx) {
				return NaN;
			}
		}

		const y = Math.floor(yRaw);
		const yFraction = yRaw - y;

		// small visual hack for "incomplete" icon global grids
		// compare: https://github.com/open-meteo/weather-map-layer/pull/148#discussion_r2681391084
		const x = Math.min(Math.floor(xRaw), this.nx - 1);
		const absDx = Math.abs(this.dx);
		const effectiveDx = this.longitudeWrap && xRaw >= this.nx - 1 ? absDx * 2 : absDx;
		const xFraction = Math.abs((lon - this.originLon) % effectiveDx) / effectiveDx;

		return interpolateLinear(values, x, y, xFraction, yFraction, this.nx, this.longitudeWrap);
	}

	getBounds(): Bounds {
		return this.bounds;
	}

	getCenter(): { lng: number; lat: number } {
		if (!this.center) {
			this.center = {
				lng: this.originLon + this.dx * (this.nx * 0.5),
				lat: this.originLat + this.dy * (this.ny * 0.5)
			};
		}
		return this.center;
	}

	getCoveringRanges(south: number, west: number, north: number, east: number): DimensionRange[] {
		// Convert geographic bounds to floating-point grid indices
		const yFromSouth = (south - this.originLat) / this.dy;
		const yFromNorth = (north - this.originLat) / this.dy;
		const xFromWest = (west - this.originLon) / this.dx;
		const xFromEast = (east - this.originLon) / this.dx;

		// Use min/max on grid indices (not geographic coordinates) to handle both positive and negative dx/dy
		const minY = Math.max(Math.floor(Math.min(yFromSouth, yFromNorth)) - 1, 0);
		const maxY = Math.min(Math.ceil(Math.max(yFromSouth, yFromNorth)) + 1, this.ny);
		const minX = Math.max(Math.floor(Math.min(xFromWest, xFromEast)) - 1, 0);
		const maxX = Math.min(Math.ceil(Math.max(xFromWest, xFromEast)) + 1, this.nx);

		return [
			{ start: minY, end: maxY },
			{ start: minX, end: maxX }
		];
	}

	forEachPoint(callback: (point: GridPoint) => void | false, bounds?: Bounds): void {
		let jStart = 0,
			jEnd = this.ny,
			iStart = 0,
			iEnd = this.nx;

		if (bounds) {
			const [minLon, minLat, maxLon, maxLat] = bounds;
			jStart = Math.max(0, Math.floor((minLat - this.bounds[1]) / this.dy));
			jEnd = Math.min(this.ny, Math.ceil((maxLat - this.bounds[1]) / this.dy) + 1);
			if (!this.longitudeWrap) {
				iStart = Math.max(0, Math.floor((minLon - this.bounds[0]) / this.dx));
				iEnd = Math.min(this.nx, Math.ceil((maxLon - this.bounds[0]) / this.dx) + 1);
			}
		}

		for (let j = jStart; j < jEnd; j++) {
			const lat = this.bounds[1] + this.dy * j;
			for (let i = iStart; i < iEnd; i++) {
				const lon = this.bounds[0] + this.dx * i;
				const result = callback({ index: j * this.nx + i, lat, lon });
				if (result === false) return;
			}
		}
	}
}
