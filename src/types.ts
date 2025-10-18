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
	label: string;
};

export type Variables = Variable[];

export type ColorScale = {
	min: number;
	max: number;
	steps: number;
	unit: string;
	steps: number;
	colors: number[][];
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

export interface Domain {
	value: string;
	label: string;
	grid: {
		nx: number;
		ny: number;
		lonMin: number;
		latMin: number;
		dx: number;
		dy: number;
		zoom?: number;
		projection?: {
			name: string;
			λ0?: number;
			ϕ0?: number;
			ϕ1?: number;
			ϕ2?: number;
			rotation?: number[];
			radius?: number;
			latitude?: number[] | number;
			longitude?: number[] | number;
			bounds?: number[];
			projectOrigin?: boolean;
		};
		center?:
			| {
					lng: number;
					lat: number;
			  }
			| Function;
	};
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

export interface IndexAndFractions {
	index: number;
	xFraction: number;
	yFraction: number;
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
