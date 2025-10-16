import {
	ProjectionGrid,
	DynamicProjection,
	type Projection,
	type ProjectionName,
	MercatorProjection
} from './projections';

import type { Domain, Bounds, Center, IndexAndFractions } from '../types';

const PI = Math.PI;

export const degreesToRadians = (degree: number) => {
	return degree * (PI / 180);
};

export const radiansToDegrees = (rad: number) => {
	return rad * (180 / PI);
};

export const tile2lon = (x: number, z: number): number => {
	return (x / Math.pow(2, z)) * 360 - 180;
};

export const tile2lat = (y: number, z: number): number => {
	const n = PI - (2 * PI * y) / Math.pow(2, z);
	return radiansToDegrees(Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
};

export const lon2tile = (lon: number, z: number): number => {
	return Math.pow(2, z) * ((lon + 180) / 360);
};

export const lat2tile = (lat: number, z: number): number => {
	return (
		(Math.pow(2, z) *
			(1 - Math.log(Math.tan(degreesToRadians(lat)) + 1 / Math.cos(degreesToRadians(lat))) / PI)) /
		2
	);
};

const a1 = 0.99997726;
const a3 = -0.33262347;
const a5 = 0.19354346;
const a7 = -0.11643287;
const a9 = 0.05265332;
const a11 = -0.0117212;

// https://mazzo.li/posts/vectorized-atan2.html
export const fastAtan2 = (y: number, x: number) => {
	const swap = Math.abs(x) < Math.abs(y);
	const denominator = (swap ? y : x) === 0 ? 0.00000001 : swap ? y : x;
	const atan_input = (swap ? x : y) / denominator;

	const z_sq = atan_input * atan_input;
	let res = atan_input * (a1 + z_sq * (a3 + z_sq * (a5 + z_sq * (a7 + z_sq * (a9 + z_sq * a11)))));

	if (swap) res = (Math.sign(atan_input) * PI) / 2 - res;
	if (x < 0.0) res = Math.sign(y) * PI + res;

	return res;
};

export const hermite = (t: number, p0: number, p1: number, m0: number, m1: number) => {
	const t2 = t * t;
	const t3 = t2 * t;

	const h00 = 2 * t3 - 3 * t2 + 1;
	const h10 = t3 - 2 * t2 + t;
	const h01 = -2 * t3 + 3 * t2;
	const h11 = t3 - t2;

	return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
};

// Estimate first derivative (symmetric central)
export const derivative = (fm1: number, fp1: number): number => {
	return (fp1 - fm1) / 2;
};

// Estimate second derivative (Laplacian-like)
export const secondDerivative = (fm1: number, f0: number, fp1: number): number => {
	return fm1 - 2 * f0 + fp1;
};

const mercator = new MercatorProjection();

export const getIndexFromLatLong = (
	lat: number,
	lon: number,
	dx: number,
	dy: number,
	nx: number,
	latLonMinMax: [minLat: number, minLon: number, maxLat: number, maxLon: number]
): IndexAndFractions => {
	if (
		lat < latLonMinMax[0] ||
		lat >= latLonMinMax[2] ||
		lon < latLonMinMax[1] ||
		lon >= latLonMinMax[3]
	) {
		return { index: NaN, xFraction: 0, yFraction: 0 };
	} else {
		const x = Math.floor((lon - latLonMinMax[1]) / dx);
		const y = Math.floor((lat - latLonMinMax[0]) / dy);

		const xFraction = ((lon - latLonMinMax[1]) % dx) / dx;
		const yFraction = ((lat - latLonMinMax[0]) % dy) / dy;

		const index = y * nx + x;
		return { index, xFraction, yFraction };
	}
};

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

		[s, w, n, e] = getRotatedSWNE(domain, projection, [south, west, north, east]);

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
	domain: Domain,
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

export const getCenterFromBounds = (bounds: Bounds): Center => {
	return {
		lng: (bounds[2] - bounds[0]) / 2 + bounds[0],
		lat: (bounds[3] - bounds[1]) / 2 + bounds[1]
	};
};

export const getCenterFromGrid = (grid: Domain['grid']): Center => {
	return {
		lng: grid.lonMin + grid.dx * (grid.nx * 0.5),
		lat: grid.latMin + grid.dy * (grid.ny * 0.5)
	};
};

export const rotatePoint = (cx: number, cy: number, theta: number, x: number, y: number) => {
	const xt = Math.cos(theta) * (x - cx) - Math.sin(theta) * (y - cy) + cx;
	const yt = Math.sin(theta) * (x - cx) + Math.cos(theta) * (y - cy) + cy;

	return [xt, yt];
};
