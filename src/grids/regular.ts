import { GridInterface } from './interface';
import { interpolateLinear } from './interpolations';

import { Bounds, DimensionRange, RegularGridData } from '../types';

// Regular grid implementation
export class RegularGrid implements GridInterface {
	private nx: number;
	private ny: number;
	private dx: number;
	private dy: number;

	private bounds: Bounds;
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

		const lonMin = data.lonMin + this.dx * ranges[1].start;
		const latMin = data.latMin + this.dy * ranges[0].start;
		const lonMax = data.lonMin + this.dx * ranges[1].end;
		const latMax = data.latMin + this.dy * ranges[0].end;
		this.bounds = [lonMin, latMin, lonMax, latMax];
	}

	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number {
		if (
			lat < this.bounds[1] ||
			lat >= this.bounds[3] ||
			lon < this.bounds[0] ||
			lon >= this.bounds[2]
		) {
			return NaN;
		}
		const x = Math.floor((lon - this.bounds[0]) / this.dx);
		const y = Math.floor((lat - this.bounds[1]) / this.dy);

		const xFraction = ((lon - this.bounds[0]) % this.dx) / this.dx;
		const yFraction = ((lat - this.bounds[1]) % this.dy) / this.dy;

		const index = y * this.nx + x;
		return interpolateLinear(values, index, xFraction, yFraction, this.nx);
	}

	getIndex(lat:number, lon:number) {
		if (
			lat < this.bounds[1] ||
			lat >= this.bounds[3] ||
			lon < this.bounds[0] ||
			lon >= this.bounds[2]
		) {
			return NaN;
		}
		const x = Math.floor((lon - this.bounds[0]) / this.dx);
		const y = Math.floor((lat - this.bounds[1]) / this.dy);

		return y * this.nx + x;
	}

	getBounds(): Bounds {
		return this.bounds;
	}

	getCenter(): { lng: number; lat: number } {
		if (!this.center) {
			this.center = {
				lng: this.bounds[0] + this.dx * (this.nx * 0.5),
				lat: this.bounds[1] + this.dy * (this.ny * 0.5)
			};
		}
		return this.center;
	}

	getCoveringRanges(south: number, west: number, north: number, east: number): DimensionRange[] {
		const dx = this.dx;
		const dy = this.dy;
		const nx = this.nx;
		const ny = this.ny;

		let xPrecision, yPrecision;
		if (String(dx).split('.')[1]) {
			xPrecision = String(dx).split('.')[1].length;
			yPrecision = String(dy).split('.')[1].length;
		} else {
			xPrecision = 2;
			yPrecision = 2;
		}

		const originX = this.bounds[0];
		const originY = this.bounds[1];

		const s = Number((south - (south % dy)).toFixed(yPrecision));
		const w = Number((west - (west % dx)).toFixed(xPrecision));
		const n = Number((north - (north % dy) + dy).toFixed(yPrecision));
		const e = Number((east - (east % dx) + dx).toFixed(xPrecision));

		let minX: number, minY: number, maxX: number, maxY: number;

		if (s - originY < 0) {
			minY = 0;
		} else {
			minY = Math.floor(Math.max((s - originY) / dy - 1, 0));
		}

		if (w - originX < 0) {
			minX = 0;
		} else {
			minX = Math.floor(Math.max((w - originX) / dx - 1, 0));
		}

		if (n - originY < 0) {
			maxY = ny;
		} else {
			maxY = Math.ceil(Math.min((n - originY) / dy + 1, ny));
		}

		if (e - originX < 0) {
			maxX = nx;
		} else {
			maxX = Math.ceil(Math.min((e - originX) / dx + 1, nx));
		}
		const ranges = [
			{ start: minY, end: maxY },
			{ start: minX, end: maxX }
		];
		return ranges;
	}
}
