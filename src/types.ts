export type TileJSON = {
	tilejson: '2.2.0';
	tiles: Array<string>;
	name?: string;
	description?: string;
	version?: string;
	attribution?: string;
	template?: string;
	legend?: string;
	scheme?: string;
	grids?: Array<string>;
	data?: Array<string>;
	minzoom: number;
	maxzoom: number;
	bounds?: Array<number>;
	center?: Array<number>;
};

export type TileIndex = {
	z: number;
	x: number;
	y: number;
};

export type Bbox = [number, number, number, number];

export type Location = {
	latitude: number;
	longitude: number;
};

export type LatLonZoom = {
	zoom: number;
	latitude: number;
	longitude: number;
};

export type TilePixel = {
	row: number;
	column: number;
	tileIndex: TileIndex;
};

export type Variable = {
	value: string;
	label?: string;
};

export type Variables = Variable[];

export type ColorScale = {
	min: number;
	max: number;
	unit: string;
	steps: number;
	colors: [number, number, number][];
	opacity?: number;
	scalefactor: number;
	interpolationMethod: InterpolationMethod;
};

export type ColorScales = {
	[key: string]: ColorScale;
};

export type InterpolationMethod = 'none' | 'linear' | 'hermite2d';

export type Interpolator = (
	values: Float32Array<ArrayBufferLike>,
	index: number,
	xFraction: number,
	yFraction: number,
	ranges: DimensionRange[]
) => number;

interface BaseGridData {
	nx: number;
	ny: number;
	zoom?: number;
}

// Union type for all grid types
export type GridData = RegularGridData | AnyProjectionGridData | GaussianGridData;

export interface GaussianGridData extends BaseGridData {
	type: 'gaussian';
	gaussianGridLatitudeLines: number;
}

export interface RegularGridData extends BaseGridData {
	type: 'regular';
	lonMin: number;
	latMin: number;
	dx: number;
	dy: number;
}

export type AnyProjectionGridData =
	| ProjectionGridFromBounds
	| ProjectionGridFromGeographicOrigin
	| ProjectionGridFromProjectedOrigin;

export interface ProjectionGridFromBounds extends BaseGridData {
	type: 'projectedFromBounds';
	projection: ProjectionData;
	nx: number;
	ny: number;
	latitudeBounds: [min: number, max: number];
	longitudeBounds: [min: number, max: number];
}

export interface ProjectionGridFromGeographicOrigin extends BaseGridData {
	type: 'projectedFromGeographicOrigin';
	projection: ProjectionData;
	nx: number;
	ny: number;
	dx: number;
	dy: number;
	latitude: number;
	longitude: number;
}

export interface ProjectionGridFromProjectedOrigin extends BaseGridData {
	type: 'projectedFromProjectedOrigin';
	projection: ProjectionData;
	nx: number;
	ny: number;
	dx: number;
	dy: number;
	projectedLatitudeOrigin: number;
	projectedLongitudeOrigin: number;
}

export type ProjectionData =
	| StereographicProjectionData
	| RotatedLatLonProjectionData
	| LCCProjectionData
	| LAEAProjectionData;

export interface StereographicProjectionData {
	name: 'StereographicProjection';
	latitude: number;
	longitude: number;
	radius?: number;
}

export interface RotatedLatLonProjectionData {
	name: 'RotatedLatLonProjection';
	rotatedLat: number;
	rotatedLon: number;
}

export interface LCCProjectionData {
	name: 'LambertConformalConicProjection';
	λ0: number;
	ϕ0: number;
	ϕ1: number;
	ϕ2: number;
	radius?: number;
}

export interface LAEAProjectionData {
	name: 'LambertAzimuthalEqualAreaProjection';
	λ0: number;
	ϕ1: number;
	radius: number;
}

export interface Domain {
	value: string;
	label?: string;
	grid: GridData;
	time_interval: number;
	model_interval: number;
	windUVComponents: boolean;
}

export interface DomainGroups {
	[key: string]: Domain[];
}

export type Bounds = [
	minimumLongitude: number,
	minimumLatitude: number,
	maximumLongitude: number,
	maximumLatitude: number
];

export interface Center {
	lng: number;
	lat: number;
}

export interface DimensionRange {
	start: number;
	end: number;
}

export interface DomainMetaData {
	completed: boolean;
	last_modified_time: string;
	reference_time: string;
	valid_times: string[];
	variables: string[];
}
