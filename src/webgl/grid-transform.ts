import { GridFactory } from '../grids';
import { Projection, createProjection } from '../grids/projections';

import type { Bounds, GridData } from '../types';

const EARTH_MERCATOR_LIMIT = 85.0511287798066;

type ProjectionConstants =
	| {
			type: 'rotated';
			cosTheta: number;
			sinTheta: number;
			cosPhi: number;
			sinPhi: number;
	  }
	| {
			type: 'lcc';
			lambda0: number;
			n: number;
			f: number;
			rho0: number;
			radius: number;
	  }
	| {
			type: 'laea';
			lambda0: number;
			sinPhi1: number;
			cosPhi1: number;
			radius: number;
	  }
	| {
			type: 'stereographic';
			lambda0: number;
			sinPhi1: number;
			cosPhi1: number;
			radius: number;
	  };

export interface WebGLGridDescriptor {
	grid: Exclude<GridData, { type: 'gaussian' }>;
	nx: number;
	ny: number;
	bounds: Bounds;
	originX: number;
	originY: number;
	dx: number;
	dy: number;
	longitudeWrap: boolean;
	wrapLastCellDouble: boolean;
	projection?: Projection;
	projectionConstants?: ProjectionConstants;
}

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

const projectionConstants = (
	projection: Exclude<GridData, { type: 'regular' | 'gaussian' }>['projection']
): ProjectionConstants => {
	switch (projection.name) {
		case 'RotatedLatLonProjection': {
			const theta = radians(90 + projection.rotatedLat);
			const phi = radians(projection.rotatedLon);
			return {
				type: 'rotated',
				cosTheta: Math.cos(theta),
				sinTheta: Math.sin(theta),
				cosPhi: Math.cos(phi),
				sinPhi: Math.sin(phi)
			};
		}
		case 'LambertConformalConicProjection': {
			const lambda0 = radians(((projection.λ0 + 180) % 360) - 180);
			const phi0 = radians(projection.ϕ0);
			const phi1 = radians(projection.ϕ1);
			const phi2 = radians(projection.ϕ2);
			const n =
				phi1 === phi2
					? Math.sin(phi1)
					: Math.log(Math.cos(phi1) / Math.cos(phi2)) /
						Math.log(Math.tan(Math.PI / 4 + phi2 / 2) / Math.tan(Math.PI / 4 + phi1 / 2));
			const f = (Math.cos(phi1) * Math.pow(Math.tan(Math.PI / 4 + phi1 / 2), n)) / n;
			return {
				type: 'lcc',
				lambda0,
				n,
				f,
				rho0: f / Math.pow(Math.tan(Math.PI / 4 + phi0 / 2), n),
				radius: projection.radius ?? 6370.997
			};
		}
		case 'LambertAzimuthalEqualAreaProjection': {
			const phi1 = radians(projection.ϕ1);
			return {
				type: 'laea',
				lambda0: radians(projection.λ0),
				sinPhi1: Math.sin(phi1),
				cosPhi1: Math.cos(phi1),
				radius: projection.radius ?? 6371229
			};
		}
		case 'StereographicProjection': {
			const phi1 = radians(projection.latitude);
			return {
				type: 'stereographic',
				lambda0: radians(projection.longitude),
				sinPhi1: Math.sin(phi1),
				cosPhi1: Math.cos(phi1),
				radius: projection.radius ?? 6371229
			};
		}
	}
};

export const createWebGLGridDescriptor = (grid: GridData): WebGLGridDescriptor => {
	if (grid.type === 'gaussian') {
		throw new Error(
			'WebGL weather layers do not support reduced Gaussian grids yet. Regrid the field to a regular grid first.'
		);
	}

	const bounds = GridFactory.create(grid).getBounds();
	if (grid.type === 'regular') {
		const originX = grid.longitude ? grid.longitude[0] : grid.lonMin;
		const originY = grid.latitude ? grid.latitude[0] : grid.latMin;
		const dx = grid.longitude ? (grid.longitude[1] - grid.longitude[0]) / (grid.nx - 1) : grid.dx;
		const dy = grid.latitude ? (grid.latitude[1] - grid.latitude[0]) / (grid.ny - 1) : grid.dy;
		const span = Math.abs(dx) * grid.nx;
		const longitudeWrap = span >= 360 - 1.5 * Math.abs(dx);
		return {
			grid,
			nx: grid.nx,
			ny: grid.ny,
			bounds: longitudeWrap
				? [-180, Math.max(-90, bounds[1]), 180, Math.min(90, bounds[3])]
				: bounds,
			originX,
			originY,
			dx,
			dy,
			longitudeWrap,
			wrapLastCellDouble: longitudeWrap && span < 360 - 0.5 * Math.abs(dx)
		};
	}

	const projection = createProjection(grid.projection);
	let originX: number;
	let originY: number;
	let dx: number;
	let dy: number;

	switch (grid.type) {
		case 'projectedFromBounds': {
			const southWest = projection.forward(grid.latitude[0], grid.longitude[0]);
			const northEast = projection.forward(grid.latitude[1], grid.longitude[1]);
			[originX, originY] = southWest;
			dx = (northEast[0] - southWest[0]) / (grid.nx - 1);
			dy = (northEast[1] - southWest[1]) / (grid.ny - 1);
			break;
		}
		case 'projectedFromGeographicOrigin':
			[originX, originY] = projection.forward(grid.latitude, grid.longitude);
			dx = grid.dx;
			dy = grid.dy;
			break;
		case 'projectedFromProjectedOrigin':
			originX = grid.longitudeProjectionOrigin;
			originY = grid.latitudeProjectionOrigin;
			dx = grid.dx;
			dy = grid.dy;
			break;
	}

	return {
		grid,
		nx: grid.nx,
		ny: grid.ny,
		bounds: [
			bounds[0],
			Math.max(-EARTH_MERCATOR_LIMIT, bounds[1]),
			bounds[2],
			Math.min(EARTH_MERCATOR_LIMIT, bounds[3])
		],
		originX,
		originY,
		dx,
		dy,
		longitudeWrap: false,
		wrapLastCellDouble: false,
		projection,
		projectionConstants: projectionConstants(grid.projection)
	};
};

const canonicalLongitude = (longitude: number): number =>
	((((longitude + 180) % 360) + 360) % 360) - 180;

export const geographicToGrid = (
	descriptor: WebGLGridDescriptor,
	latitude: number,
	longitude: number
): [x: number, y: number] => {
	const lon = canonicalLongitude(longitude);
	if (descriptor.grid.type === 'regular') {
		let x = (lon - descriptor.originX) / descriptor.dx;
		if (descriptor.longitudeWrap) {
			const period = 360 / Math.abs(descriptor.dx);
			x = ((x % period) + period) % period;
			if (descriptor.wrapLastCellDouble && x >= descriptor.nx - 1) {
				x = descriptor.nx - 1 + (x - (descriptor.nx - 1)) * 0.5;
			}
		}
		return [x, (latitude - descriptor.originY) / descriptor.dy];
	}

	const [projectedX, projectedY] = descriptor.projection!.forward(latitude, lon);
	return [
		(projectedX - descriptor.originX) / descriptor.dx,
		(projectedY - descriptor.originY) / descriptor.dy
	];
};

export const gridToGeographic = (
	descriptor: WebGLGridDescriptor,
	x: number,
	y: number
): [latitude: number, longitude: number] => {
	if (descriptor.grid.type === 'regular') {
		return [descriptor.originY + y * descriptor.dy, descriptor.originX + x * descriptor.dx];
	}
	return descriptor.projection!.reverse(
		descriptor.originX + x * descriptor.dx,
		descriptor.originY + y * descriptor.dy
	);
};

export const gridToTextureCoordinate = (
	descriptor: WebGLGridDescriptor,
	x: number,
	y: number
): [u: number, v: number] => [(x + 0.5) / descriptor.nx, (y + 0.5) / descriptor.ny];

const glslFloat = (value: number): string => {
	if (!Number.isFinite(value))
		throw new Error(`Cannot encode non-finite shader constant: ${value}`);
	const encoded = value.toPrecision(17).replace(/e\+/, 'e');
	return encoded.includes('.') || encoded.includes('e') ? encoded : `${encoded}.0`;
};

export const gridTransformShader = (descriptor: WebGLGridDescriptor): string => {
	const commonTail = `
	vec2 projectedToGrid(vec2 projected) {
		return (projected - vec2(${glslFloat(descriptor.originX)}, ${glslFloat(
			descriptor.originY
		)})) / vec2(${glslFloat(descriptor.dx)}, ${glslFloat(descriptor.dy)});
	}
`;

	if (descriptor.grid.type === 'regular') {
		return `
	float canonicalLongitude(float lon) {
		return mod(mod(lon + 180.0, 360.0) + 360.0, 360.0) - 180.0;
	}
	vec2 geographicToGrid(vec2 lonLat) {
		float x = (canonicalLongitude(lonLat.x) - ${glslFloat(
			descriptor.originX
		)}) / ${glslFloat(descriptor.dx)};
			${
				descriptor.longitudeWrap
					? `x = mod(mod(x, ${glslFloat(
							360 / Math.abs(descriptor.dx)
						)}) + ${glslFloat(360 / Math.abs(descriptor.dx))}, ${glslFloat(
							360 / Math.abs(descriptor.dx)
						)});`
					: ''
			}
		${
			descriptor.wrapLastCellDouble
				? `if (x >= ${glslFloat(descriptor.nx - 1)}) {
					x = ${glslFloat(descriptor.nx - 1)} + (x - ${glslFloat(descriptor.nx - 1)}) * 0.5;
				}`
				: ''
		}
		return vec2(x, (lonLat.y - ${glslFloat(descriptor.originY)}) / ${glslFloat(descriptor.dy)});
	}
`;
	}

	const constants = descriptor.projectionConstants!;
	let projectionBody: string;
	switch (constants.type) {
		case 'rotated':
			projectionBody = `
				float lon = radians(lonLat.x);
				float lat = radians(lonLat.y);
				float x1 = cos(lon) * cos(lat);
				float y1 = sin(lon) * cos(lat);
				float z1 = sin(lat);
				float x2 = ${glslFloat(constants.cosTheta)} * ${glslFloat(
					constants.cosPhi
				)} * x1 + ${glslFloat(constants.cosTheta)} * ${glslFloat(
					constants.sinPhi
				)} * y1 + ${glslFloat(constants.sinTheta)} * z1;
				float y2 = -${glslFloat(constants.sinPhi)} * x1 + ${glslFloat(constants.cosPhi)} * y1;
				float z2 = -${glslFloat(constants.sinTheta)} * ${glslFloat(
					constants.cosPhi
				)} * x1 - ${glslFloat(constants.sinTheta)} * ${glslFloat(
					constants.sinPhi
				)} * y1 + ${glslFloat(constants.cosTheta)} * z1;
				return vec2(-degrees(atan(y2, x2)), -degrees(asin(z2)));`;
			break;
		case 'lcc':
			projectionBody = `
				float phi = radians(lonLat.y);
				float lambda = radians(lonLat.x);
				float p = ${glslFloat(constants.f)} / pow(tan(PI * 0.25 + phi * 0.5), ${glslFloat(constants.n)});
				float theta = ${glslFloat(constants.n)} * (lambda - ${glslFloat(constants.lambda0)});
				return ${glslFloat(constants.radius)} * vec2(
					p * sin(theta),
					${glslFloat(constants.rho0)} - p * cos(theta)
				);`;
			break;
		case 'laea':
			projectionBody = `
				float lambda = radians(lonLat.x);
				float phi = radians(lonLat.y);
				float k = sqrt(2.0 / (1.0 + ${glslFloat(
					constants.sinPhi1
				)} * sin(phi) + ${glslFloat(constants.cosPhi1)} * cos(phi) * cos(lambda - ${glslFloat(
					constants.lambda0
				)})));
				return ${glslFloat(constants.radius)} * vec2(
					k * cos(phi) * sin(lambda - ${glslFloat(constants.lambda0)}),
					k * (${glslFloat(constants.cosPhi1)} * sin(phi) - ${glslFloat(
						constants.sinPhi1
					)} * cos(phi) * cos(lambda - ${glslFloat(constants.lambda0)}))
				);`;
			break;
		case 'stereographic':
			projectionBody = `
				float lambda = radians(lonLat.x);
				float phi = radians(lonLat.y);
				float k = (2.0 * ${glslFloat(constants.radius)}) /
					(1.0 + ${glslFloat(constants.sinPhi1)} * sin(phi) + ${glslFloat(
						constants.cosPhi1
					)} * cos(phi) * cos(lambda - ${glslFloat(constants.lambda0)}));
				return vec2(
					k * cos(phi) * sin(lambda - ${glslFloat(constants.lambda0)}),
					k * (${glslFloat(constants.cosPhi1)} * sin(phi) - ${glslFloat(
						constants.sinPhi1
					)} * cos(phi) * cos(lambda - ${glslFloat(constants.lambda0)}))
				);`;
			break;
	}

	return `
	const float PI = 3.141592653589793;
	float canonicalLongitude(float lon) {
		return mod(mod(lon + 180.0, 360.0) + 360.0, 360.0) - 180.0;
	}
	vec2 projectWeatherCoordinate(vec2 lonLat) {
		lonLat.x = canonicalLongitude(lonLat.x);
		${projectionBody}
	}
	${commonTail}
	vec2 geographicToGrid(vec2 lonLat) {
		return projectedToGrid(projectWeatherCoordinate(lonLat));
	}
`;
};

export const visibleWorldOffsets = (
	bounds: Bounds,
	viewportWest: number,
	viewportEast: number
): number[] => {
	const first = Math.ceil((viewportWest - bounds[2]) / 360);
	const last = Math.floor((viewportEast - bounds[0]) / 360);
	const offsets: number[] = [];
	for (let world = first; world <= last; world++) offsets.push(world * 360);
	return offsets.length ? offsets : [0];
};

export const longitudeToMercatorX = (longitude: number): number => longitude / 360 + 0.5;

export const latitudeToMercatorY = (latitude: number): number => {
	const clamped = Math.max(-EARTH_MERCATOR_LIMIT, Math.min(EARTH_MERCATOR_LIMIT, latitude));
	const radiansLatitude = radians(clamped);
	return 0.5 - Math.log(Math.tan(Math.PI / 4 + radiansLatitude / 2)) / (2 * Math.PI);
};
