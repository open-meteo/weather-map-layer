import { degreesToRadians, lat2tile, lon2tile, radiansToDegrees, tile2lat, tile2lon } from './math';

import type { Bounds, Domain } from '../types';
import type { DimensionRange } from '../types';

export interface Projection {
	forward(latitude: number, longitude: number): [x: number, y: number];
	reverse(x: number, y: number): [latitude: number, longitude: number];
}

export class MercatorProjection implements Projection {
	forward(latitude: number, longitude: number): [x: number, y: number] {
		const x = lon2tile(longitude, 0);
		const y = lat2tile(latitude, 0);
		return [x, y];
	}

	reverse(x: number, y: number): [latitude: number, longitude: number] {
		const lon = tile2lon(x, 0);
		const lat = tile2lat(y, 0);
		return [lat, lon];
	}
}

export class RotatedLatLonProjection implements Projection {
	θ: number;
	ϕ: number;
	constructor(projectionData: Domain['grid']['projection']) {
		if (projectionData) {
			const rotation = projectionData.rotation ?? [0, 0];
			this.θ = degreesToRadians(90 + rotation[0]);
			this.ϕ = degreesToRadians(rotation[1]);
		} else {
			throw new Error('projectionData not defined');
		}
	}

	forward(latitude: number, longitude: number): [x: number, y: number] {
		const lon = degreesToRadians(longitude);
		const lat = degreesToRadians(latitude);

		const x1 = Math.cos(lon) * Math.cos(lat);
		const y1 = Math.sin(lon) * Math.cos(lat);
		const z1 = Math.sin(lat);

		const x2 =
			Math.cos(this.θ) * Math.cos(this.ϕ) * x1 +
			Math.cos(this.θ) * Math.sin(this.ϕ) * y1 +
			Math.sin(this.θ) * z1;
		const y2 = -Math.sin(this.ϕ) * x1 + Math.cos(this.ϕ) * y1;
		const z2 =
			-Math.sin(this.θ) * Math.cos(this.ϕ) * x1 -
			Math.sin(this.θ) * Math.sin(this.ϕ) * y1 +
			Math.cos(this.θ) * z1;

		const x = -1 * radiansToDegrees(Math.atan2(y2, x2));
		const y = -1 * radiansToDegrees(Math.asin(z2));

		return [x, y];
	}

	reverse(x: number, y: number): [latitude: number, longitude: number] {
		const lon1 = degreesToRadians(x);
		const lat1 = degreesToRadians(y);

		// quick solution without conversion in cartesian space
		const lat2 =
			-1 *
			Math.asin(
				Math.cos(this.θ) * Math.sin(lat1) - Math.cos(lon1) * Math.sin(this.θ) * Math.cos(lat1)
			);
		const lon2 =
			-1 *
			(Math.atan2(
				Math.sin(lon1),
				Math.tan(lat1) * Math.sin(this.θ) + Math.cos(lon1) * Math.cos(this.θ)
			) -
				this.ϕ);

		const lon = ((radiansToDegrees(lon2) + 180) % 360) - 180;
		const lat = radiansToDegrees(lat2);

		return [lat, lon];
	}
}

export class LambertConformalConicProjection implements Projection {
	ρ0;
	F;
	n;
	λ0;

	R = 6370.997; // Radius of the Earth
	constructor(projectionData: Domain['grid']['projection']) {
		let λ0_dec;
		let ϕ0_dec;
		let ϕ1_dec;
		let ϕ2_dec;
		let radius;

		if (projectionData) {
			λ0_dec = projectionData.λ0;
			ϕ0_dec = projectionData.ϕ0;
			ϕ1_dec = projectionData.ϕ1;
			ϕ2_dec = projectionData.ϕ2;
			radius = projectionData.radius;
		} else {
			throw new Error('projectionData not defined');
		}

		this.λ0 = degreesToRadians((((λ0_dec as number) + 180) % 360) - 180);
		const ϕ0 = degreesToRadians(ϕ0_dec as number);
		const ϕ1 = degreesToRadians(ϕ1_dec as number);
		const ϕ2 = degreesToRadians(ϕ2_dec as number);

		if (ϕ1 == ϕ2) {
			this.n = Math.sin(ϕ1);
		} else {
			this.n =
				Math.log(Math.cos(ϕ1) / Math.cos(ϕ2)) /
				Math.log(Math.tan(Math.PI / 4 + ϕ2 / 2) / Math.tan(Math.PI / 4 + ϕ1 / 2));
		}
		this.F = (Math.cos(ϕ1) * Math.pow(Math.tan(Math.PI / 4 + ϕ1 / 2), this.n)) / this.n;
		this.ρ0 = this.F / Math.pow(Math.tan(Math.PI / 4 + ϕ0 / 2), this.n);

		if (radius) {
			this.R = radius;
		}
	}

	forward(latitude: number, longitude: number): [x: number, y: number] {
		const ϕ = degreesToRadians(latitude);
		const λ = degreesToRadians(longitude);
		// If (λ - λ0) exceeds the range:±: 180°, 360° should be added or subtracted.
		const θ = this.n * (λ - this.λ0);

		const p = this.F / Math.pow(Math.tan(Math.PI / 4 + ϕ / 2), this.n);
		const x = this.R * p * Math.sin(θ);
		const y = this.R * (this.ρ0 - p * Math.cos(θ));
		return [x, y];
	}

	reverse(x: number, y: number): [latitude: number, longitude: number] {
		const x_scaled = x / this.R;
		const y_scaled = y / this.R;

		const θ =
			this.n >= 0
				? Math.atan2(x_scaled, this.ρ0 - y_scaled)
				: Math.atan2(-1 * x_scaled, y_scaled - this.ρ0);
		const ρ =
			(this.n > 0 ? 1 : -1) * Math.sqrt(Math.pow(x_scaled, 2) + Math.pow(this.ρ0 - y_scaled, 2));

		const ϕ_rad = 2 * Math.atan(Math.pow(this.F / ρ, 1 / this.n)) - Math.PI / 2;
		const λ_rad = this.λ0 + θ / this.n;

		const λ = radiansToDegrees(λ_rad);

		const lat = radiansToDegrees(ϕ_rad);
		const lon = λ > 180 ? λ - 360 : λ;

		return [lat, lon];
	}
}

export class LambertAzimuthalEqualAreaProjection implements Projection {
	λ0;
	ϕ1;
	R = 6371229; // Radius of the Earth
	constructor(projectionData: Domain['grid']['projection']) {
		if (projectionData) {
			const λ0_dec = projectionData.λ0 as number;
			const ϕ1_dec = projectionData.ϕ1 as number;
			const radius = projectionData.radius;
			this.λ0 = degreesToRadians(λ0_dec);
			this.ϕ1 = degreesToRadians(ϕ1_dec);
			if (radius) {
				this.R = radius;
			}
		} else {
			throw new Error('projectionData not defined');
		}
	}

	forward(latitude: number, longitude: number): [x: number, y: number] {
		const λ = degreesToRadians(longitude);
		const ϕ = degreesToRadians(latitude);

		const k = Math.sqrt(
			2 /
				(1 +
					Math.sin(this.ϕ1) * Math.sin(ϕ) +
					Math.cos(this.ϕ1) * Math.cos(ϕ) * Math.cos(λ - this.λ0))
		);

		const x = this.R * k * Math.cos(ϕ) * Math.sin(λ - this.λ0);
		const y =
			this.R *
			k *
			(Math.cos(this.ϕ1) * Math.sin(ϕ) - Math.sin(this.ϕ1) * Math.cos(ϕ) * Math.cos(λ - this.λ0));

		return [x, y];
	}

	reverse(x: number, y: number): [latitude: number, longitude: number] {
		x = x / this.R;
		y = y / this.R;
		const ρ = Math.sqrt(x * x + y * y);
		const c = 2 * Math.asin(0.5 * ρ);
		const ϕ = Math.asin(
			Math.cos(c) * Math.sin(this.ϕ1) + (y * Math.sin(c) * Math.cos(this.ϕ1)) / ρ
		);
		const λ =
			this.λ0 +
			Math.atan(
				(x * Math.sin(c)) /
					(ρ * Math.cos(this.ϕ1) * Math.cos(c) - y * Math.sin(this.ϕ1) * Math.sin(c))
			);

		const lat = radiansToDegrees(ϕ);
		const lon = radiansToDegrees(λ);

		return [lat, lon];
	}
}

export class StereograpicProjection implements Projection {
	λ0: number; // Central longitude
	sinϕ1: number; // Sinus of central latitude
	cosϕ1: number; // Cosine of central latitude
	R = 6371229; // Radius of Earth
	constructor(projectionData: Domain['grid']['projection']) {
		if (projectionData) {
			this.λ0 = degreesToRadians(projectionData.longitude as number);
			this.sinϕ1 = Math.sin(degreesToRadians(projectionData.latitude as number));
			this.cosϕ1 = Math.cos(degreesToRadians(projectionData.latitude as number));
			if (projectionData.radius) {
				this.R = projectionData.radius;
			}
		} else {
			throw new Error('projectionData not defined');
		}
	}

	forward(latitude: number, longitude: number): [x: number, y: number] {
		const ϕ = degreesToRadians(latitude);
		const λ = degreesToRadians(longitude);
		const k =
			(2 * this.R) /
			(1 + this.sinϕ1 * Math.sin(ϕ) + this.cosϕ1 * Math.cos(ϕ) * Math.cos(λ - this.λ0));
		const x = k * Math.cos(ϕ) * Math.sin(λ - this.λ0);
		const y = k * (this.cosϕ1 * Math.sin(ϕ) - this.sinϕ1 * Math.cos(ϕ) * Math.cos(λ - this.λ0));
		return [x, y];
	}

	reverse(x: number, y: number): [latitude: number, longitude: number] {
		const p = Math.sqrt(x * x + y * y);
		const c = 2 * Math.atan2(p, 2 * this.R);
		const ϕ = Math.asin(Math.cos(c) * this.sinϕ1 + (y * Math.sin(c) * this.cosϕ1) / p);
		const λ =
			this.λ0 +
			Math.atan2(x * Math.sin(c), p * this.cosϕ1 * Math.cos(c) - y * this.sinϕ1 * Math.sin(c));

		const lat = radiansToDegrees(ϕ);
		const lon = radiansToDegrees(λ);

		return [lat, lon];
	}
}

const projections = {
	MercatorProjection,
	StereograpicProjection,
	RotatedLatLonProjection,
	LambertConformalConicProjection,
	LambertAzimuthalEqualAreaProjection
};

export type ProjectionName = keyof typeof projections;

export class DynamicProjection {
	constructor(projName: ProjectionName, opts: Domain['grid']['projection']) {
		return new projections[projName](opts);
	}
}

export class ProjectionGrid {
	projection;
	nx;
	ny;
	origin;
	dx; //meters
	dy; //meters
	ranges;

	constructor(
		projection: Projection,
		grid: Domain['grid'],
		ranges: DimensionRange[] = [
			{ start: 0, end: grid.ny },
			{ start: 0, end: grid.nx }
		]
	) {
		this.ranges = ranges;
		this.projection = projection;

		const latitude = grid.projection?.latitude ?? grid.latMin;
		const longitude = grid.projection?.longitude ?? grid.lonMin;
		const projectOrigin = grid.projection?.projectOrigin ?? true;

		this.nx = grid.nx;
		this.ny = grid.ny;
		if (latitude && Array === latitude.constructor && Array === longitude.constructor) {
			const sw = projection.forward(latitude[0], longitude[0]);
			const ne = projection.forward(latitude[1], longitude[1]);
			this.origin = sw;
			this.dx = (ne[0] - sw[0]) / this.nx;
			this.dy = (ne[1] - sw[1]) / this.ny;
		} else if (projectOrigin) {
			this.dx = grid.dx;
			this.dy = grid.dy;
			this.origin = this.projection.forward(latitude as number, longitude as number);
		} else {
			this.dx = grid.dx;
			this.dy = grid.dy;
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
}

export const getIndicesFromBounds = (
	south: number,
	west: number,
	north: number,
	east: number,
	domain: Domain
): [minX: number, minY: number, maxX: number, maxY: number] => {
	let dx = domain.grid.dx;
	let dy = domain.grid.dy;

	const nx = domain.grid.nx;
	const ny = domain.grid.ny;

	let xPrecision, yPrecision;
	if (String(dx).split('.')[1]) {
		xPrecision = String(dx).split('.')[1].length;
		yPrecision = String(dy).split('.')[1].length;
	} else {
		xPrecision = 2;
		yPrecision = 2;
	}

	let s: number, w: number, n: number, e: number;
	let minX: number, minY: number, maxX: number, maxY: number;

	if (domain.grid.projection) {
		const projectionName = domain.grid.projection.name;
		const projection = new DynamicProjection(
			projectionName as ProjectionName,
			domain.grid.projection
		) as Projection;
		const projectionGrid = new ProjectionGrid(projection, domain.grid);

		[s, w, n, e] = getRotatedSWNE(projection, [south, west, north, east]);

		dx = projectionGrid.dx;
		dy = projectionGrid.dy;

		// round to nearest grid point + / - 1
		s = Number((s - (s % dy)).toFixed(yPrecision));
		w = Number((w - (w % dx)).toFixed(xPrecision));
		n = Number((n - (n % dy) + dy).toFixed(yPrecision));
		e = Number((e - (e % dx) + dx).toFixed(xPrecision));

		const originX = projectionGrid.origin[0];
		const originY = projectionGrid.origin[1];

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
	} else {
		const originX = domain.grid.lonMin;
		const originY = domain.grid.latMin;

		s = Number((south - (south % dy)).toFixed(yPrecision));
		w = Number((west - (west % dx)).toFixed(xPrecision));
		n = Number((north - (north % dy) + dy).toFixed(yPrecision));
		e = Number((east - (east % dx) + dx).toFixed(xPrecision));

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
	}
	return [minX, minY, maxX, maxY];
};

export const getRotatedSWNE = (
	projection: Projection,
	[south, west, north, east]: [number, number, number, number]
): [localSouth: number, localWest: number, localNorth: number, localEast: number] => {
	const pointsX = [];
	const pointsY = [];

	// loop over viewport bounds with resolution of 0.01 degree
	// project these to local points
	for (let i = south; i < north; i += 0.01) {
		const point = projection.forward(i, west);
		pointsX.push(point[0]);
		pointsY.push(point[1]);
	}
	for (let i = west; i < east; i += 0.01) {
		const point = projection.forward(north, i);
		pointsX.push(point[0]);
		pointsY.push(point[1]);
	}
	for (let i = north; i > south; i -= 0.01) {
		const point = projection.forward(i, east);
		pointsX.push(point[0]);
		pointsY.push(point[1]);
	}
	for (let i = east; i > west; i -= 0.01) {
		const point = projection.forward(south, i);
		pointsX.push(point[0]);
		pointsY.push(point[1]);
	}

	// then find out minima and maxima
	const ls = Math.min(...pointsY);
	const lw = Math.min(...pointsX);
	const ln = Math.max(...pointsY);
	const le = Math.max(...pointsX);

	return [ls, lw, ln, le];
};

export const getBorderPoints = (projectionGrid: ProjectionGrid) => {
	const points = [];
	for (let i = 0; i < projectionGrid.ny; i++) {
		points.push([projectionGrid.origin[0], projectionGrid.origin[1] + i * projectionGrid.dy]);
	}
	for (let i = 0; i < projectionGrid.nx; i++) {
		points.push([
			projectionGrid.origin[0] + i * projectionGrid.dx,
			projectionGrid.origin[1] + projectionGrid.ny * projectionGrid.dy
		]);
	}
	for (let i = projectionGrid.ny; i >= 0; i--) {
		points.push([
			projectionGrid.origin[0] + projectionGrid.nx * projectionGrid.dx,
			projectionGrid.origin[1] + i * projectionGrid.dy
		]);
	}
	for (let i = projectionGrid.nx; i >= 0; i--) {
		points.push([projectionGrid.origin[0] + i * projectionGrid.dx, projectionGrid.origin[1]]);
	}
	return points;
};
export const getBoundsFromBorderPoints = (
	borderPoints: number[][],
	projection: Projection
): Bounds => {
	let minLon = 180;
	let minLat = 90;
	let maxLon = -180;
	let maxLat = -90;
	for (const borderPoint of borderPoints) {
		const borderPointLatLon = projection.reverse(borderPoint[0], borderPoint[1]);
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
};

export const getBoundsFromGrid = (
	lonMin: number,
	latMin: number,
	dx: number,
	dy: number,
	nx: number,
	ny: number
): Bounds => {
	const minLon = lonMin;
	const minLat = latMin;
	const maxLon = minLon + dx * nx;
	const maxLat = minLat + dy * ny;
	return [minLon, minLat, maxLon, maxLat];
};
