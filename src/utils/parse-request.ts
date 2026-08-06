import { currentBounds, setClippingBounds } from './bounds';
import { type ResolvedClippingOptions, resolveClippingOptions } from './clipping';
import {
	DEFAULT_ARROW_STYLE,
	DEFAULT_COLOR_BLEND,
	DEFAULT_INTERPOLATION,
	DEFAULT_INTERVAL,
	DEFAULT_TILE_SIZE,
	RESOLVE_DOMAIN_REGEX,
	VALID_ARROW_STYLES,
	VALID_INTERPOLATIONS,
	VALID_TILE_SIZES
} from './constants';
import { parseUrlComponents } from './parse-url';
import { getColorScale, resolveColorScale } from './styling';

import type {
	ArrowStyle,
	ClippingOptions,
	ColorScales,
	DataIdentityOptions,
	Domain,
	InterpolationMethod,
	OmProtocolSettings,
	ParsedRequest,
	ParsedUrlComponents,
	RenderOptions,
	RenderableColorScale,
	TileSize
} from '../types';

let cachedClippingInput: ClippingOptions = undefined;
let cachedClippingResult: ResolvedClippingOptions | undefined = undefined;
let useSAB: boolean | undefined = undefined;

export const getCachedResolvedClipping = (
	options: ClippingOptions
): ResolvedClippingOptions | undefined => {
	if (options === cachedClippingInput) {
		return cachedClippingResult;
	}
	cachedClippingInput = options;
	cachedClippingResult = resolveClippingOptions(options, useSAB);
	return cachedClippingResult;
};

export const parseRequest = (url: string, settings: OmProtocolSettings): ParsedRequest => {
	const urlComponents = parseUrlComponents(url);
	const resolver = settings.resolveRequest ?? defaultResolveRequest;
	const { dataOptions, renderOptions } = resolver(urlComponents, settings);

	useSAB = settings.fileReaderConfig.useSAB;
	const resolvedClippingOptions = getCachedResolvedClipping(settings.clippingOptions);
	setClippingBounds(resolvedClippingOptions?.bounds);

	return {
		baseUrl: urlComponents.baseUrl,
		fileAndVariableKey: urlComponents.fileAndVariableKey,
		tileIndex: urlComponents.tileIndex,
		dataOptions,
		renderOptions,
		clippingOptions: resolvedClippingOptions
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

	const domainValue = baseUrl.match(RESOLVE_DOMAIN_REGEX)?.groups?.domain;

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
	const interpolation = parseInterpolation(params.get('interpolation'));
	const colorBlend =
		params.get('color_blend') === null ? DEFAULT_COLOR_BLEND : params.get('color_blend') === 'true';

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
	const arrowStyle = parseArrowStyle(params.get('arrow_style'));
	const drawContours = params.get('contours') === 'true';

	return {
		tileSize,
		interpolation,
		colorBlend,
		drawGrid,
		drawArrows,
		arrowStyle,
		drawContours,
		colorScale,
		intervals
	};
};

const parseTileSize = (value: string | null): TileSize => {
	const tileSize = value ? Number(value) : DEFAULT_TILE_SIZE;
	if (!VALID_TILE_SIZES.includes(tileSize)) {
		throw new Error(`Invalid tile size, please use one of: ${VALID_TILE_SIZES.join(', ')}`);
	}
	return tileSize as TileSize;
};

const parseArrowStyle = (value: string | null): ArrowStyle => {
	const arrowStyle = value ?? DEFAULT_ARROW_STYLE;
	if (!VALID_ARROW_STYLES.includes(arrowStyle as ArrowStyle)) {
		throw new Error(`Invalid arrow style, please use one of: ${VALID_ARROW_STYLES.join(', ')}`);
	}
	return arrowStyle as ArrowStyle;
};

const parseInterpolation = (value: string | null): InterpolationMethod => {
	const interpolation = value ?? DEFAULT_INTERPOLATION;
	if (!VALID_INTERPOLATIONS.includes(interpolation as InterpolationMethod)) {
		throw new Error(`Invalid interpolation, please use one of: ${VALID_INTERPOLATIONS.join(', ')}`);
	}
	return interpolation as InterpolationMethod;
};
