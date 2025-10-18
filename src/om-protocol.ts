import { type GetResourceResponse, type RequestParameters } from 'maplibre-gl';

import { setupGlobalCache } from '@openmeteo/file-reader';

import { WorkerPool } from './worker-pool';

import { getIndexFromLatLong } from './utils/math';

import {
	getBorderPoints,
	getBoundsFromGrid,
	getIndicesFromBounds,
	getBoundsFromBorderPoints
} from './utils/projections';

import {
	getInterpolator,
	colorScales as defaultColorScales,
	getColorScale
} from './utils/color-scales';

import { domainOptions } from './utils/domains';
import { variableOptions } from './utils/variables';

import {
	DynamicProjection,
	ProjectionGrid,
	type Projection,
	type ProjectionName
} from './utils/projections';

import { OMapsFileReader } from './om-file-reader';

import { arrowSvg } from './utils/arrow';

import type {
	Bounds,
	Domain,
	Variable,
	TileJSON,
	TileIndex,
	ColorScale,
	DimensionRange,
	ColorScales
} from './types';

let dark = false;
let partial = false;
let domain: Domain;
let variable: Variable;
let mapBounds: number[];
let omapsFileReader: OMapsFileReader;
let mapBoundsIndexes: number[];
let ranges: DimensionRange[];

let projection: Projection;
let projectionGrid: ProjectionGrid;

setupGlobalCache();

let arrowPixelData: ImageDataArray | undefined;
const initPixelData = async () => {
	// Helper to load SVG string into pixel data
	const renderIcon = async (svgText: string): Promise<ImageDataArray> => {
		const canvas = new OffscreenCanvas(32, 32);
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				const ctx = canvas.getContext('2d');
				if (!ctx) {
					reject(new Error('Failed to get 2D context'));
					return;
				}
				ctx.drawImage(img, 0, 0, 32, 32);
				const iconData = ctx.getImageData(0, 0, 32, 32).data;
				resolve(iconData);
			};
			img.onerror = reject;
			img.src = `data:image/svg+xml;base64,${btoa(svgText)}`;
		});
	};
	// Only load if not already loaded
	if (arrowPixelData) {
		return;
	}
	arrowPixelData = await renderIcon(arrowSvg);
};

export interface Data {
	values: Float32Array | undefined;
	directions: Float32Array | undefined;
}

let data: Data;

const TILE_SIZE = 256 * 2;
const workerPool = new WorkerPool();

export const getValueFromLatLong = (
	lat: number,
	lon: number,
	colorScale: ColorScale
): { index: number; value: number; direction?: number } => {
	if (data) {
		const values = data.values;

		const lonMin = domain.grid.lonMin + domain.grid.dx * ranges[1]['start'];
		const latMin = domain.grid.latMin + domain.grid.dy * ranges[0]['start'];
		const lonMax = domain.grid.lonMin + domain.grid.dx * ranges[1]['end'];
		const latMax = domain.grid.latMin + domain.grid.dy * ranges[0]['end'];

		let indexObject;
		if (domain.grid.projection) {
			indexObject = projectionGrid.findPointInterpolated(lat, lon, ranges);
		} else {
			indexObject = getIndexFromLatLong(
				lat,
				lon,
				domain.grid.dx,
				domain.grid.dy,
				ranges[1]['end'] - ranges[1]['start'],
				[latMin, lonMin, latMax, lonMax]
			);
		}

		const { index, xFraction, yFraction } = indexObject ?? {
			index: NaN,
			xFraction: 0,
			yFraction: 0
		};

		if (values && index) {
			const interpolator = getInterpolator(colorScale);

			const px = interpolator(values, index, xFraction, yFraction, ranges);

			return { index: index, value: px };
		} else {
			return { index: NaN, value: NaN };
		}
	} else {
		return { index: NaN, value: NaN };
	}
};

const getTile = async ({ z, x, y }: TileIndex, omUrl: string): Promise<ImageBitmap> => {
	const key = `${omUrl}/${TILE_SIZE}/${z}/${x}/${y}`;

	return await workerPool.requestTile({
		type: 'GT',

		x,
		y,
		z,
		key,
		data,
		dark: dark,
		ranges,
		domain,
		variable,
		colorScale:
			setColorScales?.custom ?? setColorScales[variable.value] ?? getColorScale(variable.value),
		mapBounds: mapBounds,
		northArrow: arrowPixelData!
	});
};

const URL_REGEX = /^om:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)$/;

const renderTile = async (url: string) => {
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
	return await getTile({ z, x, y }, omUrl);
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

const initOMFile = (url: string, useSAB: boolean): Promise<void> => {
	initPixelData();

	return new Promise((resolve, reject) => {
		const [omUrl, omParams] = url.replace('om://', '').split('?');

		const urlParams = new URLSearchParams(omParams);
		dark = urlParams.get('dark') === 'true';
		partial = urlParams.get('partial') === 'true';
		domain = domainOptions.find((dm) => dm.value === omUrl.split('/')[4]) ?? domainOptions[0];
		variable =
			variableOptions.find((v) => urlParams.get('variable') === v.value) ?? variableOptions[0];
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

		if (!omapsFileReader) {
			omapsFileReader = new OMapsFileReader(domain, partial, useSAB);
		}

		omapsFileReader.setReaderData(domain, partial);
		omapsFileReader
			.init(omUrl)
			.then(() => {
				omapsFileReader.readVariable(variable, ranges).then((values) => {
					data = values;
					resolve();
					// prefetch first bytes of the previous and next timesteps to trigger CF caching
					omapsFileReader.prefetch(omUrl);
				});
			})
			.catch((e) => {
				reject(e);
			});
	});
};

let setColorScales: ColorScales;
export const omProtocol = async (
	params: RequestParameters,
	abortController?: AbortController,
	useSAB = false,
	colorScales = defaultColorScales
): Promise<GetResourceResponse<TileJSON | ImageBitmap>> => {
	if (params.type == 'json') {
		setColorScales = colorScales;
		try {
			await initOMFile(params.url, useSAB);
		} catch (e) {
			throw new Error(e as string);
		}
		return {
			data: await getTilejson(params.url)
		};
	} else if (params.type == 'image') {
		return {
			data: await renderTile(params.url)
		};
	} else {
		throw new Error(`Unsupported request type '${params.type}'`);
	}
};
