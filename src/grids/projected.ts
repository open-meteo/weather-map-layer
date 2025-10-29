import { GridInterface } from './interface';
import { interpolateLinear } from './interpolations';
import { DynamicProjection, Projection, ProjectionName, getRotatedSWNE } from './projections';

import { Bounds, Center, DimensionRange, ProjectedGridData } from '../types';

export class ProjectionGrid implements GridInterface {
	private projection: Projection;
	private nx: number;
	private ny: number;
	private origin: [x: number, y: number];
	private dx: number; //meters
	private dy: number; //meters
	private ranges: DimensionRange[];
	private bounds?: Bounds;
	private center?: { lng: number; lat: number };

	constructor(data: ProjectedGridData, ranges: DimensionRange[] | null = null) {
		this.projection = new DynamicProjection(
			data.projection.name as ProjectionName,
			data.projection
		) as Projection;

		if (!ranges) {
			ranges = [
				{ start: 0, end: data.ny },
				{ start: 0, end: data.nx }
			];
		}
		this.ranges = ranges;

		const latitude = data.projection.latitude ?? data.latMin;
		const longitude = data.projection.longitude ?? data.lonMin;
		const projectOrigin = data.projection.projectOrigin ?? true;

		this.nx = data.nx;
		this.ny = data.ny;
		if (latitude && Array === latitude.constructor && Array === longitude.constructor) {
			const sw = this.projection.forward(latitude[0], longitude[0]);
			const ne = this.projection.forward(latitude[1], longitude[1]);
			this.origin = sw;
			this.dx = (ne[0] - sw[0]) / this.nx;
			this.dy = (ne[1] - sw[1]) / this.ny;
		} else if (projectOrigin) {
			this.dx = data.dx;
			this.dy = data.dy;
			this.origin = this.projection.forward(latitude as number, longitude as number);
		} else {
			this.dx = data.dx;
			this.dy = data.dy;
			this.origin = [latitude as number, longitude as number];
		}
	}

	findPointInterpolated(lat: number, lon: number, ranges: DimensionRange[]) {
		const [xPos, yPos] = this.projection.forward(lat, lon);

		const minX = this.origin[0] + this.dx * ranges[1]['start'];
		const minY = this.origin[1] + this.dy * ranges[0]['start'];

		const x = (xPos - minX) / this.dx;
		const y = (yPos - minY) / this.dy;

		const xFraction = x - Math.floor(x);
		const yFraction = y - Math.floor(y);

		if (
			x < 0 ||
			x >= ranges[1]['end'] - ranges[1]['start'] ||
			y < 0 ||
			y >= ranges[0]['end'] - ranges[0]['start']
		) {
			return { index: NaN, xFraction: 0, yFraction: 0 };
		}
		const index = Math.floor(y) * (ranges[1]['end'] - ranges[1]['start']) + Math.floor(x);
		return { index, xFraction, yFraction };
	}

	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number {
		const idx = this.findPointInterpolated(lat, lon, this.ranges);
		return interpolateLinear(
			values,
			idx.index,
			idx.xFraction,
			idx.yFraction,
			this.ranges[1].end - this.ranges[1].start
		);
	}

	getBorderPoints(): number[][] {
		const points = [];
		for (let i = 0; i < this.ny; i++) {
			points.push([this.origin[0], this.origin[1] + i * this.dy]);
		}
		for (let i = 0; i < this.nx; i++) {
			points.push([this.origin[0] + i * this.dx, this.origin[1] + this.ny * this.dy]);
		}
		for (let i = this.ny; i >= 0; i--) {
			points.push([this.origin[0] + this.nx * this.dx, this.origin[1] + i * this.dy]);
		}
		for (let i = this.nx; i >= 0; i--) {
			points.push([this.origin[0] + i * this.dx, this.origin[1]]);
		}
		return points;
	}

	getBoundsFromBorderPoints(borderPoints: number[][]): Bounds {
		let minLon = 180;
		let minLat = 90;
		let maxLon = -180;
		let maxLat = -90;
		for (const borderPoint of borderPoints) {
			const borderPointLatLon = this.projection.reverse(borderPoint[0], borderPoint[1]);
			if (borderPointLatLon[0] < minLat) {
				minLat = borderPointLatLon[0];
			}
			if (borderPointLatLon[0] > maxLat) {
				maxLat = borderPointLatLon[0];
			}
			if (borderPointLatLon[1] < minLon) {
				minLon = borderPointLatLon[1];
			}
			if (borderPointLatLon[1] > maxLon) {
				maxLon = borderPointLatLon[1];
			}
		}
		return [minLon, minLat, maxLon, maxLat];
	}

	getCenterFromBounds(bounds: Bounds): Center {
		return {
			lng: (bounds[2] - bounds[0]) / 2 + bounds[0],
			lat: (bounds[3] - bounds[1]) / 2 + bounds[1]
		};
	}

	getBounds(): Bounds {
		if (!this.bounds) {
			const borderPoints = this.getBorderPoints();
			this.bounds = this.getBoundsFromBorderPoints(borderPoints);
		}
		return this.bounds;
	}

	getCenter(): { lng: number; lat: number } {
		if (!this.center) {
			const bounds = this.getBounds();
			this.center = this.getCenterFromBounds(bounds);
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

		let [s, w, n, e] = getRotatedSWNE(this.projection, [south, west, north, east]);

		// round to nearest grid point + / - 1
		s = Number((s - (s % dy)).toFixed(yPrecision));
		w = Number((w - (w % dx)).toFixed(xPrecision));
		n = Number((n - (n % dy) + dy).toFixed(yPrecision));
		e = Number((e - (e % dx) + dx).toFixed(xPrecision));

		const originX = this.origin[0];
		const originY = this.origin[1];

		let minX: number, minY: number, maxX: number, maxY: number;

		if (dx > 0) {
			minX = Math.min(Math.max(Math.floor((w - originX) / dx - 1), 0), nx);
			maxX = Math.max(Math.min(Math.ceil((e - originX) / dx + 1), nx), 0);
		} else {
			minX = Math.min(Math.max(Math.floor((e - originX) / dx - 1), 0), nx);
			maxX = Math.max(Math.min(Math.ceil((w - originX) / dx + 1), nx), 0);
		}

		if (dy > 0) {
			minY = Math.min(Math.max(Math.floor((s - originY) / dy - 1), 0), ny);
			maxY = Math.max(Math.min(Math.ceil((n - originY) / dy + 1), ny), 0);
		} else {
			minY = Math.min(Math.max(Math.floor((n - originY) / dy - 1), 0), ny);
			maxY = Math.max(Math.min(Math.ceil((s - originY) / dy + 1), ny), 0);
		}
		const ranges = [
			{ start: minY, end: maxY },
			{ start: minX, end: maxX }
		];
		return ranges;
	}
}
