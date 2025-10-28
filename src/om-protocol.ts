import { setupGlobalCache } from '@openmeteo/file-reader';
import { type GetResourceResponse, type RequestParameters } from 'maplibre-gl';

import {
	colorScales as defaultColorScales,
	getColorScale,
	getInterpolator
} from './utils/color-scales';
import { MS_TO_KMH } from './utils/constants';
import { domainOptions as defaultDomainOptions } from './utils/domains';
import { GaussianGrid } from './utils/gaussian';
import {
	getBorderPoints,
	getBoundsFromBorderPoints,
	getBoundsFromGrid,
	getIndexAndFractions,
	getIndicesFromBounds
} from './utils/projections';
import {
	DynamicProjection,
	type Projection,
	ProjectionGrid,
	type ProjectionName
} from './utils/projections';
import { variableOptions as defaultVariableOptions } from './utils/variables';

import { OMapsFileReader } from './om-file-reader';
import { capitalize } from './utils';
import { TilePromise, WorkerPool } from './worker-pool';

import type {
	Bounds,
	ColorScale,
	ColorScales,
	DimensionRange,
	Domain,
	TileIndex,
	TileJSON,
	Variable
} from './types';

let dark = false;
let partial = false;
let tileSize = 128;
let interval = 2;
let domain: Domain;
let variable: Variable;
let mapBounds: number[];
let omFileReader: OMapsFileReader;
let resolutionFactor = 1;
let mapBoundsIndexes: number[];
let ranges: DimensionRange[];

let projection: Projection;
let projectionGrid: ProjectionGrid;

setupGlobalCache();

export interface Data {
	values: Float32Array | undefined;
	directions: Float32Array | undefined;
}

let data: Data;

const workerPool = new WorkerPool();

export const getValueFromLatLong = (
	lat: number,
	lon: number,
	variable: Variable,
	colorScale: ColorScale
): { value: number; direction?: number } => {
	if (!data?.values) {
		return { value: NaN };
	}

	const values = data.values;
	const lonMin = domain.grid.lonMin + domain.grid.dx * ranges[1]['start'];
	const latMin = domain.grid.latMin + domain.grid.dy * ranges[0]['start'];
	const lonMax = domain.grid.lonMin + domain.grid.dx * ranges[1]['end'];
	const latMax = domain.grid.latMin + domain.grid.dy * ranges[0]['end'];

	if (domain.grid.gaussianGridLatitudeLines) {
		const gaussian = new GaussianGrid(domain.grid.gaussianGridLatitudeLines);
		const value = gaussian.getLinearInterpolatedValue(values, lat, lon);
		return { value: value };
	} else {
		const { index, xFraction, yFraction } = getIndexAndFractions(
			lat,
			((((lon + 180) % 360) + 360) % 360) - 180,
			domain,
			projectionGrid,
			ranges,
			[latMin, lonMin, latMax, lonMax]
		);

		const interpolator = getInterpolator(colorScale);
		let px = interpolator(values, index, xFraction, yFraction, ranges);
		if (variable.value.includes('wind')) {
			px = px * MS_TO_KMH;
		}

		return { value: px };
	}
};

const getTile = async (
	{ z, x, y }: TileIndex,
	omUrl: string,
	type: 'image' | 'arrayBuffer'
): TilePromise => {
	const key = `${omUrl}/${tileSize}/${z}/${x}/${y}`;

	return await workerPool.requestTile({
		type: ('get' + capitalize(type)) as 'getImage' | 'getArrayBuffer',
		x,
		y,
		z,
		key,
		data,
		dark,
		ranges,
		tileSize: resolutionFactor * tileSize,
		interval,
		domain,
		variable,
		colorScale:
			setColorScales?.custom ?? setColorScales[variable.value] ?? getColorScale(variable.value),
		mapBounds: mapBounds
	});
};

const URL_REGEX = /^om:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)$/;

const renderTile = async (url: string, type: 'image' | 'arrayBuffer') => {
	const result = url.match(URL_REGEX);
	if (!result) {
		throw new Error(`Invalid OM protocol URL '${url}'`);
	}
	const urlParts = result[1].split('#');
	const omUrl = urlParts[0];

	const z = parseInt(result[2]);
	const x = parseInt(result[3]);
	const y = parseInt(result[4]);

	// Read OM data
	return await getTile({ z, x, y }, omUrl, type);
};

const getTilejson = async (fullUrl: string): Promise<TileJSON> => {
	let bounds: Bounds;
	if (domain.grid.projection) {
		const projectionName = domain.grid.projection.name;
		projection = new DynamicProjection(
			projectionName as ProjectionName,
			domain.grid.projection
		) as Projection;
		projectionGrid = new ProjectionGrid(projection, domain.grid);

		const borderPoints = getBorderPoints(projectionGrid);
		bounds = getBoundsFromBorderPoints(borderPoints, projection);
	} else {
		bounds = getBoundsFromGrid(
			domain.grid.lonMin,
			domain.grid.latMin,
			domain.grid.dx,
			domain.grid.dy,
			domain.grid.nx,
			domain.grid.ny
		);
	}

	return {
		tilejson: '2.2.0',
		tiles: [fullUrl + '/{z}/{x}/{y}'],
		attribution: '<a href="https://open-meteo.com">Open-Meteo</a>',
		minzoom: 0,
		maxzoom: 12,
		bounds: bounds
	};
};

let setColorScales: ColorScales;
let setDomainOptions: Domain[];
let setVariableOptions: Variable[];
export const initOMFile = (url: string, omProtocolSettings: OmProtocolSettings): Promise<void> => {
	return new Promise((resolve, reject) => {
		const { useSAB } = omProtocolSettings;
		tileSize = omProtocolSettings.tileSize;
		setColorScales = omProtocolSettings.colorScales;
		resolutionFactor = omProtocolSettings.resolutionFactor;
		setDomainOptions = omProtocolSettings.domainOptions;
		setVariableOptions = omProtocolSettings.variableOptions;

		const { partial, domain, variable, ranges, omUrl } = omProtocolSettings.parseUrlCallback(url);

		if (!omFileReader) {
			omFileReader = new OMapsFileReader(domain, partial, useSAB);
		}

		omFileReader.setReaderData(domain, partial);
		omFileReader
			.init(omUrl)
			.then(() => {
				omFileReader.readVariable(variable, ranges).then((values) => {
					data = values;
					resolve();

					if (omProtocolSettings.postReadCallback) {
						omProtocolSettings.postReadCallback(omFileReader, omUrl, data);
					}
				});
			})
			.catch((e) => {
				reject(e);
			});
	});
};

/**
 * Parses an OM protocol URL and extracts settings for rendering.
 * Returns an object with dark mode, partial mode, domain, variable, ranges, and omUrl.
 */
export const parseOmUrl = (url: string): OmParseUrlCallbackResult => {
	const [omUrl, omParams] = url.replace('om://', '').split('?');

	const urlParams = new URLSearchParams(omParams);
	dark = urlParams.get('dark') === 'true';
	partial = urlParams.get('partial') === 'true';
	interval = Number(urlParams.get('interval'));
	domain = setDomainOptions.find((dm) => dm.value === omUrl.split('/')[4]) ?? setDomainOptions[0];
	variable =
		setVariableOptions.find((v) => urlParams.get('variable') === v.value) ?? setVariableOptions[0];
	mapBounds = urlParams
		.get('bounds')
		?.split(',')
		.map((b: string): number => Number(b)) as number[];

	if (partial) {
		mapBoundsIndexes = getIndicesFromBounds(
			mapBounds[0],
			mapBounds[1],
			mapBounds[2],
			mapBounds[3],
			domain
		);
		ranges = [
			{ start: mapBoundsIndexes[1], end: mapBoundsIndexes[3] },
			{ start: mapBoundsIndexes[0], end: mapBoundsIndexes[2] }
		];
	} else {
		ranges = [
			{ start: 0, end: domain.grid.ny },
			{ start: 0, end: domain.grid.nx }
		];
	}
	return { partial, domain, variable, ranges, omUrl };
};

export interface OmParseUrlCallbackResult {
	partial: boolean;
	domain: Domain;
	variable: Variable;
	ranges: DimensionRange[];
	omUrl: string;
}

export interface OmProtocolSettings {
	tileSize: number;
	useSAB: boolean;
	colorScales: ColorScales;
	domainOptions: Domain[];
	variableOptions: Variable[];
	resolutionFactor: 0.5 | 1 | 2;
	parseUrlCallback: (url: string) => OmParseUrlCallbackResult;
	postReadCallback:
		| ((omFileReader: OMapsFileReader, omUrl: string, data: Data) => void)
		| undefined;
}

export const defaultOmProtocolSettings: OmProtocolSettings = {
	tileSize: 256,
	useSAB: false,
	colorScales: defaultColorScales,
	domainOptions: defaultDomainOptions,
	variableOptions: defaultVariableOptions,
	resolutionFactor: 1,
	parseUrlCallback: parseOmUrl,
	postReadCallback: undefined
};

export const omProtocol = async (
	params: RequestParameters,
	abortController?: AbortController,
	omProtocolSettings = defaultOmProtocolSettings
): Promise<GetResourceResponse<TileJSON | ImageBitmap | ArrayBuffer>> => {
	if (params.type == 'json') {
		try {
			await initOMFile(params.url, omProtocolSettings);
		} catch (e) {
			throw new Error(e as string);
		}
		return {
			data: await getTilejson(params.url)
		};
	} else if (params.type && ['image', 'arrayBuffer'].includes(params.type)) {
		return {
			data: await renderTile(params.url, params.type as 'image' | 'arrayBuffer')
		};
	} else {
		throw new Error(`Unsupported request type '${params.type}'`);
	}
};
