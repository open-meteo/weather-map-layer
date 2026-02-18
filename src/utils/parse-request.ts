import { currentBounds } from './bounds';
import {
	DEFAULT_INTERVAL,
	DEFAULT_TILE_SIZE,
	RESOLVE_DOMAIN_REGEX,
	VALID_TILE_SIZES
} from './constants';
import { parseUrlComponents } from './parse-url';
import { getColorScale, resolveColorScale } from './styling';

import type {
	ColorScales,
	DataIdentityOptions,
	Domain,
	OmProtocolSettings,
	ParsedRequest,
	ParsedUrlComponents,
	RenderOptions,
	RenderableColorScale
} from '../types';

export const parseRequest = (url: string, settings: OmProtocolSettings): ParsedRequest => {
	const urlComponents = parseUrlComponents(url);
	const resolver = settings.resolveRequest ?? defaultResolveRequest;
	const { dataOptions, renderOptions } = resolver(urlComponents, settings);

	return {
		baseUrl: urlComponents.baseUrl,
		fileAndVariableKey: urlComponents.fileAndVariableKey,
		tileIndex: urlComponents.tileIndex,
		dataOptions,
		renderOptions,
		clippingOptions: settings.clippingOptions
	};
};

export const defaultResolveRequest = (
	urlComponents: ParsedUrlComponents,
	settings: OmProtocolSettings
): { dataOptions: DataIdentityOptions; renderOptions: RenderOptions } => {
	const dataOptions = defaultResolveDataIdentity(urlComponents, settings.domainOptions);

	const renderOptions = defaultResolveRenderOptions(
		urlComponents,
		dataOptions,
		settings.colorScales
	);

	return { dataOptions, renderOptions };
};

const defaultResolveDataIdentity = (
	urlComponents: ParsedUrlComponents,
	domainOptions: Domain[]
): DataIdentityOptions => {
	const { baseUrl, params } = urlComponents;

	const match = baseUrl.match(RESOLVE_DOMAIN_REGEX);
	const domainValue = match?.groups?.domain;

	if (!domainValue) {
		throw new Error(`Could not parse domain from URL: ${baseUrl}`);
	}
	const domain = domainOptions.find((dm) => dm.value === domainValue);
	if (!domain) {
		throw new Error(`Invalid domain: ${domainValue}`);
	}

	const variable = params.get('variable');
	if (!variable) {
		throw new Error(`Variable is required but not defined`);
	}

	const mapBounds = currentBounds;

	return { domain, variable, bounds: mapBounds };
};

const defaultResolveRenderOptions = (
	urlComponents: ParsedUrlComponents,
	dataOptions: DataIdentityOptions,
	colorScales: ColorScales
): RenderOptions => {
	const { params } = urlComponents;

	const dark = params.get('dark') === 'true';
	let colorScale: RenderableColorScale;
	if (colorScales.custom) {
		colorScale = resolveColorScale(colorScales.custom, dark);
	} else {
		colorScale = getColorScale(dataOptions.variable, dark, colorScales);
	}

	const tileSize = parseTileSize(params.get('tile_size'));

	let intervals = [DEFAULT_INTERVAL];
	if (params.get('intervals')) {
		intervals = params
			.get('intervals')
			?.split(',')
			.map((interval) => Number(interval)) as number[];
	} else if (colorScale.type === 'breakpoint') {
		intervals = colorScale.breakpoints;
	}

	const drawGrid = params.get('grid') === 'true';
	const drawArrows = params.get('arrows') === 'true';
	const drawContours = params.get('contours') === 'true';

	return {
		tileSize,
		drawGrid,
		drawArrows,
		drawContours,
		colorScale,
		intervals
	};
};

const parseTileSize = (value: string | null): 64 | 128 | 256 | 512 | 1024 => {
	const tileSize = value ? Number(value) : DEFAULT_TILE_SIZE;
	if (!VALID_TILE_SIZES.includes(tileSize)) {
		throw new Error(`Invalid tile size, please use one of: ${VALID_TILE_SIZES.join(', ')}`);
	}
	return tileSize as 64 | 128 | 256 | 512 | 1024;
};
