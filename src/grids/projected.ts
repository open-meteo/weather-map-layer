import { GridInterface, GridPoint } from './interface';
import { interpolateLinear } from './interpolations';
import { Projection, createProjection } from './projections';

import {
	Bounds,
	Center,
	DimensionRange,
	ProjectionGridFromBounds,
	ProjectionGridFromGeographicOrigin,
	ProjectionGridFromProjectedOrigin
} from '../types';

export class ProjectionGrid implements GridInterface {
	private projection: Projection;

	// origin in projected coordinates
	private origin: [x: number, y: number];
	private dx: number; //meters
	private dy: number; //meters

	// minX and minY are the same as origin[0] and origin[1], if the grid is not "reduced" via the ranges
	private minX: number;
	private minY: number;
	private nx: number;
	private ny: number;

	private bounds?: Bounds;
	private center?: { lng: number; lat: number };

	constructor(
		data:
			| ProjectionGridFromBounds
			| ProjectionGridFromProjectedOrigin
			| ProjectionGridFromGeographicOrigin,
		ranges: DimensionRange[] | null = null
	) {
		if (!ranges) {
			ranges = [
				{ start: 0, end: data.ny },
				{ start: 0, end: data.nx }
			];
		}

		this.nx = ranges[1].end - ranges[1].start;
		this.ny = ranges[0].end - ranges[0].start;

		switch (data.type) {
			case 'projectedFromBounds': {
				this.projection = createProjection(data.projection);
				const sw = this.projection.forward(data.latitudeBounds[0], data.longitudeBounds[0]);
				const ne = this.projection.forward(data.latitudeBounds[1], data.longitudeBounds[1]);
				this.origin = sw;
				this.dx = (ne[0] - sw[0]) / (data.nx - 1);
				this.dy = (ne[1] - sw[1]) / (data.ny - 1);
				break;
			}
			case 'projectedFromGeographicOrigin': {
				this.projection = createProjection(data.projection);
				this.origin = this.projection.forward(data.latitude, data.longitude);
				this.dx = data.dx;
				this.dy = data.dy;
				break;
			}
			case 'projectedFromProjectedOrigin': {
				this.projection = createProjection(data.projection);
				this.origin = [data.projectedLongitudeOrigin, data.projectedLatitudeOrigin];
				this.dx = data.dx;
				this.dy = data.dy;
				break;
			}
			default: {
				// This ensures exhaustiveness checking
				const _exhaustive: never = data;
				throw new Error(`Unknown projection: ${_exhaustive}`);
			}
		}

		this.minX = this.origin[0] + this.dx * ranges[1].start;
		this.minY = this.origin[1] + this.dy * ranges[0].start;
	}

	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number {
		const idx = this.findPointInterpolated(lat, lon);
		return interpolateLinear(values, idx.x, idx.y, idx.xFraction, idx.yFraction, this.nx);
	}

	getBounds(): Bounds {
		if (!this.bounds) {
			const borderPoints = this.getProjectedBorderPoints();
			this.bounds = this.calculateGeographicBounds(borderPoints);
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

		let [s, w, n, e] = getProjectedBounds(this.projection, [south, west, north, east]);

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

	findPointInterpolated(lat: number, lon: number) {
		const [xPos, yPos] = this.projection.forward(lat, lon);

		const x = (xPos - this.minX) / this.dx;
		const y = (yPos - this.minY) / this.dy;

		const xFraction = x - Math.floor(x);
		const yFraction = y - Math.floor(y);

		if (x < 0 || x >= this.nx || y < 0 || y >= this.ny) {
			return { x: NaN, y: NaN, xFraction: 0, yFraction: 0 };
		}
		return { x: Math.floor(x), y: Math.floor(y), xFraction, yFraction };
	}

	/**
	 * Traces the grid's outer edge through the projection, returning a closed
	 * `[lon, lat]` ring that follows the true (curved) domain boundary rather than
	 * the axis-aligned bounding box. Each edge is sampled at up to
	 * `maxPointsPerEdge` points so the curvature is captured without emitting one
	 * vertex per grid column/row.
	 */
	getBoundaryPolygon(maxPointsPerEdge = 64): Array<[number, number]> {
		const ring: Array<[number, number]> = [];
		let prevLon: number | null = null;
		const add = (projX: number, projY: number): void => {
			const [lat, lonRaw] = this.projection.reverse(projX, projY);
			let lon = ((((lonRaw + 180) % 360) + 360) % 360) - 180; // normalize to [-180, 180]
			// Unwrap relative to the previous vertex so the ring stays continuous
			// across the antimeridian / around a pole instead of jumping ~360°.
			if (prevLon !== null) {
				lon -= 360 * Math.round((lon - prevLon) / 360);
			}
			prevLon = lon;
			ring.push([lon, lat]);
		};

		const xEnd = this.minX + (this.nx - 1) * this.dx;
		const yEnd = this.minY + (this.ny - 1) * this.dy;
		const stepX = Math.max(1, Math.ceil((this.nx - 1) / maxPointsPerEdge));
		const stepY = Math.max(1, Math.ceil((this.ny - 1) / maxPointsPerEdge));

		// Walk the perimeter counter-clockwise: bottom → right → top → left.
		for (let i = 0; i < this.nx - 1; i += stepX) add(this.minX + i * this.dx, this.minY);
		for (let j = 0; j < this.ny - 1; j += stepY) add(xEnd, this.minY + j * this.dy);
		for (let i = this.nx - 1; i > 0; i -= stepX) add(this.minX + i * this.dx, yEnd);
		for (let j = this.ny - 1; j > 0; j -= stepY) add(this.minX, this.minY + j * this.dy);
		add(this.minX, this.minY); // close the ring
		return ring;
	}

	edgeDistanceDeg(lat: number, lon: number): number {
		// In projection space the grid is an axis-aligned rectangle, so distance to
		// the nearest edge — measured in grid cells — traces the true curved boundary
		// when mapped back to lon/lat. Convert that cell distance to an approximate
		// degree distance using the grid's mean cell size so it stays comparable to
		// `blendWidthDeg`.
		const [px, py] = this.projection.forward(lat, lon);
		const x = (px - this.minX) / this.dx; // fractional column, 0..nx-1 inside
		const y = (py - this.minY) / this.dy; // fractional row, 0..ny-1 inside
		const colDist = Math.min(x, this.nx - 1 - x);
		const rowDist = Math.min(y, this.ny - 1 - y);

		const [minLon, minLat, maxLon, maxLat] = this.getBounds();
		const degPerCol = (maxLon - minLon) / (this.nx - 1);
		const degPerRow = (maxLat - minLat) / (this.ny - 1);
		return Math.min(colDist * degPerCol, rowDist * degPerRow);
	}

	private getProjectedBorderPoints(): number[][] {
		const points = [];
		for (let i = 0; i < this.ny; i++) {
			points.push([this.minX, this.minY + i * this.dy]);
		}
		for (let i = 0; i < this.nx; i++) {
			points.push([this.minX + i * this.dx, this.minY + this.ny * this.dy]);
		}
		for (let i = this.ny; i >= 0; i--) {
			points.push([this.minX + this.nx * this.dx, this.minY + i * this.dy]);
		}
		for (let i = this.nx; i >= 0; i--) {
			points.push([this.minX + i * this.dx, this.minY]);
		}
		return points;
	}

	private calculateGeographicBounds(borderPoints: number[][]): Bounds {
		let minLon = 180;
		let minLat = 90;
		let maxLon = -180;
		let maxLat = -90;
		for (const borderPoint of borderPoints) {
			const borderPointLatLon = this.projection.reverse(borderPoint[0], borderPoint[1]);
			const lon = ((borderPointLatLon[1] + 180) % 360) - 180;
			const lat = borderPointLatLon[0];
			if (lat < minLat) {
				minLat = lat;
			}
			if (lat > maxLat) {
				maxLat = lat;
			}
			if (lon < minLon) {
				minLon = lon;
			}
			if (lon > maxLon) {
				maxLon = lon;
			}
		}
		return [minLon, minLat, maxLon, maxLat];
	}

	private getCenterFromBounds(bounds: Bounds): Center {
		return {
			lng: (bounds[2] - bounds[0]) / 2 + bounds[0],
			lat: (bounds[3] - bounds[1]) / 2 + bounds[1]
		};
	}

	forEachPoint(callback: (point: GridPoint) => void | false, bounds?: Bounds): void {
		for (let j = 0; j < this.ny; j++) {
			const projY = this.minY + this.dy * j;
			for (let i = 0; i < this.nx; i++) {
				const projX = this.minX + this.dx * i;
				const [lat, lon] = this.projection.reverse(projX, projY);
				if (bounds) {
					if (lat < bounds[1] || lat > bounds[3] || lon < bounds[0] || lon > bounds[2]) continue;
				}
				const result = callback({ index: j * this.nx + i, lat, lon });
				if (result === false) return;
			}
		}
	}
}

const getProjectedBounds = (
	projection: Projection,
	[south, west, north, east]: [number, number, number, number],
	resolution: number = 0.01
): [localSouth: number, localWest: number, localNorth: number, localEast: number] => {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	const updateBounds = (lat: number, lon: number) => {
		const [x, y] = projection.forward(lat, lon);
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
	};

	const stepsLat = Math.ceil((north - south) / resolution);
	const stepsLon = Math.ceil((east - west) / resolution);

	// West and east edge
	for (let i = 0; i <= stepsLat; i++) {
		updateBounds(north - i * resolution, east); // East edge
		updateBounds(south + i * resolution, west); // West edge
	}

	// North and south edge
	for (let i = 0; i <= stepsLon; i++) {
		updateBounds(north, west + i * resolution); // North edge
		updateBounds(south, east - i * resolution); // South edge
	}

	return [minY, minX, maxY, maxX];
};
