import { GridInterface, GridPoint } from './interface';
import { interpolateLinear } from './interpolations';

import { Bounds, DimensionRange, RegularGridData } from '../types';

// Regular grid implementation
export class RegularGrid implements GridInterface {
	private nx: number;
	private ny: number;
	private dx: number;
	private dy: number;

	private bounds: Bounds;
	private longitudeWrap: boolean;
	private center?: { lng: number; lat: number };

	constructor(data: RegularGridData, ranges: DimensionRange[] | null = null) {
		// normalise both forms to an origin (lonMin/latMin) + spacing (dx/dy)
		let originLon: number;
		let originLat: number;
		if (data.latitude && data.longitude) {
			originLon = data.longitude[0];
			originLat = data.latitude[0];
			// inclusive bounds: divide by (n - 1) so the last node lands on the upper bound
			this.dx = (data.longitude[1] - data.longitude[0]) / (data.nx - 1);
			this.dy = (data.latitude[1] - data.latitude[0]) / (data.ny - 1);
		} else {
			originLon = data.lonMin;
			originLat = data.latMin;
			this.dx = data.dx;
			this.dy = data.dy;
		}

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

		const lonMin = originLon + this.dx * ranges[1].start;
		const latMin = originLat + this.dy * ranges[0].start;
		const lonMax = originLon + this.dx * ranges[1].end;
		const latMax = originLat + this.dy * ranges[0].end;
		this.bounds = [lonMin, latMin, lonMax, latMax];

		// icon global is one grid point short, therefore compare to 359.875
		this.longitudeWrap = lonMax - lonMin >= 359.875 ? true : false;
	}

	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number {
		// check longitude is within bounds
		if (!this.longitudeWrap) {
			if (lon < this.bounds[0] || lon > this.bounds[2]) {
				return NaN;
			}
		}

		// check latitude is within bounds
		if (lat < this.bounds[1] || lat >= this.bounds[3]) {
			return NaN;
		}
		const y = Math.floor((lat - this.bounds[1]) / this.dy);
		const yFraction = ((lat - this.bounds[1]) % this.dy) / this.dy;

		// small visual hack for "incomplete" icon global grids
		// compare: https://github.com/open-meteo/weather-map-layer/pull/148#discussion_r2681391084
		const x = Math.min(Math.floor((lon - this.bounds[0]) / this.dx), this.nx - 1);
		const dx = this.longitudeWrap && lon >= this.bounds[2] - this.dx ? this.dx * 2 : this.dx;
		const xFraction = ((lon - this.bounds[0]) % dx) / dx;

		return interpolateLinear(values, x, y, xFraction, yFraction, this.nx, this.longitudeWrap);
	}

	getBounds(): Bounds {
		return this.bounds;
	}

	getBoundaryPolygon(): Array<[number, number]> {
		const [minLon, minLat, maxLon, maxLat] = this.bounds;
		return [
			[minLon, minLat],
			[maxLon, minLat],
			[maxLon, maxLat],
			[minLon, maxLat],
			[minLon, minLat]
		];
	}

	edgeDistanceDeg(lat: number, lon: number): number {
		const [minLon, minLat, maxLon, maxLat] = this.bounds;
		return Math.min(lon - minLon, maxLon - lon, lat - minLat, maxLat - lat);
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
