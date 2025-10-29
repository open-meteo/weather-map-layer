import { GridInterface } from './interface';
import { interpolateLinear } from './interpolations';

import { Bounds, DimensionRange, RegularGridData } from '../types';

// Regular grid implementation
export class RegularGrid implements GridInterface {
	private data: RegularGridData;
	private bounds: Bounds;
	private ranges: DimensionRange[];
	private center?: { lng: number; lat: number };

	constructor(data: RegularGridData, ranges: DimensionRange[] | null = null) {
		this.data = data;
		if (!ranges) {
			ranges = [
				{ start: 0, end: data.ny },
				{ start: 0, end: data.nx }
			];
		}
		this.ranges = ranges;
		const lonMin = data.lonMin + data.dx * ranges[1]['start'];
		const latMin = data.latMin + data.dy * ranges[0]['start'];
		const lonMax = data.lonMin + data.dx * ranges[1]['end'];
		const latMax = data.latMin + data.dy * ranges[0]['end'];
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
		const x = Math.floor((lon - this.bounds[0]) / this.data.dx);
		const y = Math.floor((lat - this.bounds[1]) / this.data.dy);

		const xFraction = ((lon - this.bounds[0]) % this.data.dx) / this.data.dx;
		const yFraction = ((lat - this.bounds[1]) % this.data.dy) / this.data.dy;

		const index = y * this.data.nx + x;
		return interpolateLinear(
			values,
			index,
			xFraction,
			yFraction,
			this.ranges[1].end - this.ranges[1].start
		);
	}

	getBounds(): Bounds {
		return this.bounds;
	}

	getCenter(): { lng: number; lat: number } {
		if (!this.center) {
			this.center = {
				lng: this.data.lonMin + this.data.dx * (this.data.nx * 0.5),
				lat: this.data.latMin + this.data.dy * (this.data.ny * 0.5)
			};
		}
		return this.center;
	}

	getCoveringRanges(south: number, west: number, north: number, east: number): DimensionRange[] {
		const dx = this.data.dx;
		const dy = this.data.dy;
		const nx = this.data.nx;
		const ny = this.data.ny;

		let xPrecision, yPrecision;
		if (String(dx).split('.')[1]) {
			xPrecision = String(dx).split('.')[1].length;
			yPrecision = String(dy).split('.')[1].length;
		} else {
			xPrecision = 2;
			yPrecision = 2;
		}

		const originX = this.data.lonMin;
		const originY = this.data.latMin;

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
