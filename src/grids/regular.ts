import { GridInterface, GridPoint } from './interface';
import {
	interpolateCubic,
	interpolateLinear,
	interpolateMonotone,
	interpolateNearest
} from './interpolations';

import { Bounds, DimensionRange, InterpolationMethod, RegularGridData } from '../types';

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
	// True only for global grids stored one grid point short of the seam (e.g.
	// ICON), whose final cell is physically 2*dx wide. Complete global grids
	// (e.g. GFS/GEFS) keep a normal final cell.
	private wrapLastCellDouble: boolean;
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

		// Origin = coordinates at grid index [0, 0] of this (sub)grid
		this.originLon = originLon + this.dx * ranges[1].start;
		this.originLat = originLat + this.dy * ranges[0].start;

		// End = coordinates one step past the last grid index
		const endLon = originLon + this.dx * ranges[1].end;
		const endLat = originLat + this.dy * ranges[0].end;

		// Bounds: [west, south, east, north]
		// Longitude preserves natural direction for antimeridian support
		// Latitude is always ordered south <= north
		const west = this.dx >= 0 ? this.originLon : endLon;
		const east = this.dx >= 0 ? endLon : this.originLon;
		const south = this.dy >= 0 ? this.originLat : endLat;
		const north = this.dy >= 0 ? endLat : this.originLat;
		this.bounds = [west, south, east, north];

		// Detect global longitude wrapping relative to the grid resolution so it
		// holds at any dx. A complete global grid spans |dx|*nx == 360; some grids
		// (ICON family) are stored one grid point short, spanning |dx|*nx == 360 - |dx|.
		// Both must wrap across the antimeridian — anything ≥2 cells short is
		// regional. The old hardcoded 359.875 threshold only matched the 0.125°
		// ICON grid, so e.g. dwd_icon_eps (0.25°, 359.75°) failed to wrap and left
		// a missing column at the antimeridian.
		const absDx = Math.abs(this.dx);
		const lonSpan = this.nx * absDx;
		this.longitudeWrap = lonSpan >= 360 - 1.5 * absDx;
		// Only the one-grid-point-short grids have a final cell that is physically
		// 2*dx wide (the seam node is missing and bridged by the wrap column). A
		// truly complete global grid already has a full-width final cell, so
		// widening it shifts the last column and smears the data near the
		// antimeridian (the artefact seen on e.g. ncep_gefs025/ncep_gfs025).
		this.wrapLastCellDouble = this.longitudeWrap && lonSpan < 360 - 0.5 * absDx;
	}

	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number {
		return this.getInterpolatedValue(values, lat, lon, 'linear');
	}

	getInterpolatedValue(
		values: Float32Array,
		lat: number,
		lon: number,
		method: InterpolationMethod
	): number {
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
		const effectiveDx = this.wrapLastCellDouble && xRaw >= this.nx - 1 ? absDx * 2 : absDx;
		const xFraction = Math.abs((lon - this.originLon) % effectiveDx) / effectiveDx;

		switch (method) {
			// 'nearest' returns the value of the closest grid node (round), centred on the node exactly like the
			// interpolating methods. Flooring would offset every cell by half a
			// cell up/right (RegularGrid.swift registers values at lonMin+i*dx).
			case 'nearest':
				return interpolateNearest(
					values,
					x,
					y,
					xFraction,
					yFraction,
					this.nx,
					this.ny,
					this.longitudeWrap
				);
			case 'cubic':
				return interpolateCubic(
					values,
					x,
					y,
					xFraction,
					yFraction,
					this.nx,
					this.ny,
					this.longitudeWrap
				);
			case 'monotone':
				return interpolateMonotone(
					values,
					x,
					y,
					xFraction,
					yFraction,
					this.nx,
					this.ny,
					this.longitudeWrap
				);
			case 'linear':
				return interpolateLinear(values, x, y, xFraction, yFraction, this.nx, this.longitudeWrap);
			default: {
				// Exhaustiveness check; also throws at runtime for untyped callers.
				const _exhaustive: never = method;
				throw new Error(`Unknown interpolation method: ${_exhaustive}`);
			}
		}
	}

	getBounds(): Bounds {
		return this.bounds;
	}

	getBoundaryPolygon(): Array<[number, number]> {
		// `bounds` sit one cell beyond the last data point on the side the step walks
		// towards (origin + d · count), whereas the origin side is the first data
		// point. Pull that end side in by one cell so the outline hugs the rendered
		// data instead of leaving a one-cell seam — which side that is depends on the
		// sign of the step (e.g. cams_europe stores rows north-to-south, dy < 0).
		const [minLon, minLat, maxLon, maxLat] = this.bounds;
		const west = this.dx >= 0 ? minLon : minLon + Math.abs(this.dx);
		const east = this.dx >= 0 ? maxLon - this.dx : maxLon;
		const south = this.dy >= 0 ? minLat : minLat + Math.abs(this.dy);
		const north = this.dy >= 0 ? maxLat - this.dy : maxLat;
		return [
			[west, south],
			[east, south],
			[east, north],
			[west, north],
			[west, south]
		];
	}

	edgeDistanceDeg(lat: number, lon: number): number {
		const [minLon, minLat, maxLon, maxLat] = this.bounds;
		return Math.min(lon - minLon, maxLon - lon, lat - minLat, maxLat - lat);
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
			const yFromMinLat = (minLat - this.originLat) / this.dy;
			const yFromMaxLat = (maxLat - this.originLat) / this.dy;
			jStart = Math.max(0, Math.floor(Math.min(yFromMinLat, yFromMaxLat)));
			jEnd = Math.min(this.ny, Math.ceil(Math.max(yFromMinLat, yFromMaxLat)) + 1);
			if (!this.longitudeWrap) {
				const xFromMinLon = (minLon - this.originLon) / this.dx;
				const xFromMaxLon = (maxLon - this.originLon) / this.dx;
				iStart = Math.max(0, Math.floor(Math.min(xFromMinLon, xFromMaxLon)));
				iEnd = Math.min(this.nx, Math.ceil(Math.max(xFromMinLon, xFromMaxLon)) + 1);
			}
		}

		for (let j = jStart; j < jEnd; j++) {
			const lat = this.originLat + this.dy * j;
			for (let i = iStart; i < iEnd; i++) {
				const lon = this.originLon + this.dx * i;
				const result = callback({ index: j * this.nx + i, lat, lon });
				if (result === false) return;
			}
		}
	}
}
