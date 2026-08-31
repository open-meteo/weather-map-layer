import { type GetResourceResponse, type RequestParameters } from 'maplibre-gl';

import { VALID_TILE_SIZES } from './utils/constants';
import { parseTileIndex } from './utils/parse-url';

import { workerPool } from './worker-pool-instance';

import type { RGB, SunShadowOptions, TileJSON, TileResponse, TileSize } from './types';

/**
 * MapLibre protocol rendering the day/night terminator as a raster overlay.
 * Tiles are computed analytically in the worker pool, no data is fetched.
 *
 * URL format: sun://shadow?<params> with query parameters:
 * - time:      ISO 8601 UTC timestamp the sun position is computed for
 *              (default: now)
 * - opacity:   maximum shadow opacity on the night side, 0..1 (default 0.5)
 * - gradient:  twilight width in degrees of solar elevation over which the
 *              shadow fades in below the terminator; 0 = hard edge (default 6,
 *              the civil twilight; 12/18 = nautical/astronomical twilight)
 * - color:     shadow colour as (#)rrggbb hex (default 000820, a dark navy)
 * - tile_size: rendered tile size in pixels (default 256)
 */

const SUN_PREFIX_REGEX = /^sun:\/\/([^?]*)(?:\?(.*))?$/;

export const DEFAULT_SUN_SHADOW_OPACITY = 0.5;
export const DEFAULT_SUN_SHADOW_GRADIENT = 6;
export const DEFAULT_SUN_SHADOW_COLOR: RGB = [0, 8, 32];
const DEFAULT_SUN_SHADOW_TILE_SIZE: TileSize = 256;

// The shadow is a planet-scale gradient, so deeper zoom levels can be served
// by raster overzoom of the maxzoom tiles without visible quality loss.
const SUN_SHADOW_MAX_ZOOM = 6;

const parseShadowColor = (value: string | null): RGB => {
	if (!value) return DEFAULT_SUN_SHADOW_COLOR;
	const hex = value.replace('#', '');
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
		throw new Error(`Invalid sun shadow color '${value}', expected rrggbb hex`);
	}
	return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4), 16)];
};

const parseNumberParam = (value: string | null, fallback: number, name: string): number => {
	if (value === null) return fallback;
	const parsed = Number(value);
	if (!isFinite(parsed)) {
		throw new Error(`Invalid sun shadow ${name}: ${value}`);
	}
	return parsed;
};

const parseSunShadowOptions = (
	params: URLSearchParams
): { shadowOptions: SunShadowOptions; tileSize: TileSize } => {
	const timeParam = params.get('time');
	const time = timeParam ? Date.parse(timeParam) : Date.now();
	if (isNaN(time)) {
		throw new Error(`Invalid sun shadow time: ${timeParam}`);
	}

	const opacity = Math.min(
		Math.max(parseNumberParam(params.get('opacity'), DEFAULT_SUN_SHADOW_OPACITY, 'opacity'), 0),
		1
	);
	const gradient = Math.max(
		parseNumberParam(params.get('gradient'), DEFAULT_SUN_SHADOW_GRADIENT, 'gradient'),
		0
	);
	const color = parseShadowColor(params.get('color'));

	const tileSize = parseNumberParam(
		params.get('tile_size'),
		DEFAULT_SUN_SHADOW_TILE_SIZE,
		'tile size'
	);
	if (!VALID_TILE_SIZES.includes(tileSize)) {
		throw new Error(`Invalid tile size, please use one of: ${VALID_TILE_SIZES.join(', ')}`);
	}

	return { shadowOptions: { time, opacity, gradient, color }, tileSize: tileSize as TileSize };
};

export const sunProtocol = async (
	params: RequestParameters,
	abortController: AbortController
): Promise<GetResourceResponse<TileJSON | TileResponse | null>> => {
	const signal = abortController.signal;
	if (signal.aborted) {
		return { data: null };
	}

	const { tileIndex, remainingUrl } = parseTileIndex(params.url);
	const match = remainingUrl.match(SUN_PREFIX_REGEX);
	if (!match) {
		throw new Error(`Invalid sun protocol URL: ${params.url}`);
	}
	const urlParams = new URLSearchParams(match[2] ?? '');

	if (params.type === 'json') {
		return {
			data: {
				tilejson: '3.0.0',
				tiles: [params.url + '/{z}/{x}/{y}'],
				minzoom: 0,
				maxzoom: SUN_SHADOW_MAX_ZOOM,
				bounds: [-180, -85.051129, 180, 85.051129]
			} as TileJSON
		};
	}

	if (params.type !== 'image') {
		throw new Error(`Unsupported request type '${params.type}'`);
	}
	if (!tileIndex) {
		throw new Error('Tile coordinates required for image request');
	}

	const { shadowOptions, tileSize } = parseSunShadowOptions(urlParams);

	const tileResult = await workerPool.requestTile({
		type: 'getShadowImage',
		key: `image:${params.url}`,
		tileIndex,
		tileSize,
		shadowOptions,
		signal
	});

	if (tileResult.cancelled || !tileResult.data) {
		return { data: null };
	}
	return { data: tileResult.data };
};
