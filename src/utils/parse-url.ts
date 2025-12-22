import { pad } from '.';
import { domainOptions } from '../domains';

import {
	DOMAIN_META_REGEX,
	OM_PREFIX_REGEX,
	RENDERING_ONLY_PARAMS,
	TILE_SUFFIX_REGEX,
	TIME_STEP_REGEX,
	VALID_OM_URL_REGEX
} from './constants';

import { ParsedUrlComponents, TileIndex } from '../types';

const parseTileIndex = (url: string): { tileIndex: TileIndex | null; remainingUrl: string } => {
	const match = url.match(TILE_SUFFIX_REGEX);
	if (!match) {
		return { tileIndex: null, remainingUrl: url };
	}

	return {
		tileIndex: {
			z: parseInt(match[1]),
			x: parseInt(match[2]),
			y: parseInt(match[3])
		},
		remainingUrl: url.slice(0, match.index)
	};
};

/**
 * Parses URL structure - this is always done internally.
 * Handles om:// prefix, query params, and tile coordinates.
 *
 * The URL structure is:
 * om://<baseUrl>?<params>/<z>/<x>/<y>  (tile request)
 * om://<baseUrl>?<params>              (tilejson request)
 * om://<baseUrl>/<z>/<x>/<y>           (tile request, no params)
 * om://<baseUrl>                       (tilejson request, no params)
 */
export const parseUrlComponents = (url: string): ParsedUrlComponents => {
	const { tileIndex, remainingUrl } = parseTileIndex(url);

	const match = remainingUrl.match(OM_PREFIX_REGEX);
	if (!match) {
		throw new Error(`Invalid OM protocol URL: ${url}`);
	}

	const [, baseUrl, queryString] = match;
	const params = new URLSearchParams(queryString ?? '');

	// Build state key from baseUrl + only data-affecting params
	const dataParams = new URLSearchParams();
	for (const [key, value] of params) {
		if (!RENDERING_ONLY_PARAMS.has(key)) {
			dataParams.set(key, value);
		}
	}
	dataParams.sort();
	const paramString = dataParams.toString();
	const stateKey = paramString ? `${baseUrl}?${paramString}` : baseUrl;

	return { baseUrl, params, stateKey, tileIndex };
};

/**
 * Returns positive amount if modifier is '+' or 'undefined', returns negative amount otherwise
 */
const getModifiedAmount = (amount: number, modifier = '+') => {
	if (modifier === '+' || modifier === undefined) return amount;
	return -amount;
};

export const parseMetaJson = async (omUrl: string) => {
	let date = new Date();
	const url = omUrl.replace('om://', '');
	const { uri, domain, meta } = url.match(DOMAIN_META_REGEX)?.groups as {
		uri: string;
		domain: string;
		meta: string; // E.G. latest | in-progress
	};
	const latest = await fetch(`https://${uri}/${domain}/${meta}.json`).then((response) =>
		response.json()
	);
	const modelRun = new Date(latest.reference_time);

	const parsedOmUrl = new URL(url);
	const timeStep = parsedOmUrl.searchParams.get('time_step');
	const timeStepMatch = timeStep?.match(TIME_STEP_REGEX);
	if (timeStep && timeStepMatch) {
		const { capture, modifier, amountAndUnit } = timeStepMatch.groups as {
			capture: string;
			modifier: undefined | '+' | '-';
			amountAndUnit: undefined | string;
		};
		if (capture === 'current_time') {
			if (amountAndUnit) {
				const splitAmountAndUnit = amountAndUnit.match(/[a-zA-Z]+|[0-9]+/g);
				if (splitAmountAndUnit) {
					const amount = splitAmountAndUnit
						? getModifiedAmount(Number(splitAmountAndUnit[0]), modifier)
						: 0;

					const unit = splitAmountAndUnit[1] ?? undefined;

					if (amount && unit === 'M') {
						date.setMinutes(date.getMinutes() + amount);
					} else if (amount && unit === 'H') {
						date.setHours(date.getHours() + amount);
					} else if (amount && unit === 'd') {
						date.setDate(date.getDate() + amount);
					} else if (amount && unit === 'm') {
						date.setMonth(date.getMonth() + amount);
					} else {
						throw new Error('Modifier or amount not supported ');
					}
				} else {
					throw new Error('Could not parse amount and or unit ');
				}
			} else {
				// it will take the current hour selected with date object at the beginning of this function
			}
		} else if (capture === 'valid_times') {
			if (amountAndUnit) {
				const index = Number(amountAndUnit);
				date = new Date(latest.valid_times[index]);
			} else {
				throw new Error('Missing valid times index');
			}
		}
	} else {
		// if no time_step defined, then take the first valid time
		date = new Date(latest.valid_times[0]);
	}
	parsedOmUrl.searchParams.delete('time_step'); // delete time_step urlSearchParam since it has no effect on map

	// we need to return a URL that is not percent encoded
	return decodeURIComponent(
		'om://' +
			parsedOmUrl.href.replace(
				`${meta}.json`,
				`${modelRun.getUTCFullYear()}/${pad(modelRun.getUTCMonth() + 1)}/${pad(modelRun.getUTCDate())}/${pad(modelRun.getUTCHours())}00Z/${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}00.om`
			)
	);
};

export const assertOmUrlValid = (url: string) => {
	const groups = url.match(VALID_OM_URL_REGEX)?.groups;
	if (!groups) return false;

	const { domain, runYear } = groups;

	if (!domainOptions.find((d) => d.value == domain)) throw new Error('Invalid Domain');
	if (Number(runYear) < 2025) throw new Error('Model run too far in the past');

	return true;
};
