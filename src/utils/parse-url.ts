import { pad } from '.';
import { getConcreteDomainValue, isSeamlessDomain } from '../domain-helpers';

import {
	DATA_RELEVANT_PARAMS,
	DOMAIN_META_REGEX,
	OM_PREFIX_REGEX,
	RUN_AND_VALID_TIME_REGEX,
	TILE_SUFFIX_REGEX,
	TIME_STEP_REGEX
} from './constants';

import { AnyDomain, DomainMetaDataJson, ParsedUrlComponents, TileIndex } from '../types';

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
		if (DATA_RELEVANT_PARAMS.has(key)) {
			dataParams.set(key, value);
		}
	}
	const paramString = dataParams.toString();
	const fileAndVariableKey = paramString ? `${baseUrl}?${paramString}` : baseUrl;

	return { baseUrl, params, fileAndVariableKey, tileIndex };
};

/**
 * Returns positive amount if modifier is '+' or 'undefined', returns negative amount otherwise
 */
const getModifiedAmount = (amount: number, modifier = '+') => {
	if (modifier === '+' || modifier === undefined) return amount;
	return -amount;
};

// {meta}.json files are cached for 60 seconds
const metaDataCache = new Map<string, Promise<DomainMetaDataJson>>();

/**
 * Swaps the `data_spatial/<domain>` segment of an om URL. Seamless composites
 * only exist client-side: the server serves the concrete sub-domains, so every
 * request for a composite is issued under a concrete domain's path.
 */
export const replaceUrlDomain = (
	url: string,
	fromDomainValue: string,
	toDomainValue: string
): string => url.replace(`/data_spatial/${fromDomainValue}/`, `/data_spatial/${toDomainValue}/`);

/**
 * Lead time in hours (model run to valid time) of a data-spatial file URL, or
 * undefined for URLs without the run/valid-time path structure.
 */
export const parseLeadTimeHours = (url: string): number | undefined => {
	const groups = url.match(RUN_AND_VALID_TIME_REGEX)?.groups;
	if (!groups) return undefined;
	const hhmm = (time: string) => `${time.slice(0, 2)}:${time.slice(2)}:00Z`;
	const modelRun = Date.parse(`${groups.runDate.replace(/\//g, '-')}T${hhmm(groups.runTime)}`);
	const validTime = Date.parse(`${groups.validDate}T${hhmm(groups.validTime)}`);
	return (validTime - modelRun) / 3_600_000;
};

/**
 * A seamless composite has no metadata of its own on the server; its global
 * layer's `{meta}.json` describes the composite.
 */
const resolveJsonFetchUrl = (jsonUrl: string, domainOptions?: AnyDomain[]): string => {
	if (!domainOptions) return jsonUrl;
	// The meta regex, not RESOLVE_DOMAIN_REGEX: that one only matches `.om`
	// paths, so a `{meta}.json` URL would never be rewritten
	const urlDomainValue = jsonUrl.match(DOMAIN_META_REGEX)?.groups?.domain;
	if (!urlDomainValue) return jsonUrl;
	const domain = domainOptions.find((d) => d.value === urlDomainValue);
	if (!domain || !isSeamlessDomain(domain)) return jsonUrl;
	return replaceUrlDomain(jsonUrl, urlDomainValue, getConcreteDomainValue(domain));
};

export const parseMetaJson = async (omUrl: string, domainOptions?: AnyDomain[]) => {
	let date = new Date();
	const url = omUrl.replace('om://', '');

	// jsonUrl should be everything until ".json" of the current url (inclusive)
	const jsonIndex = url.indexOf('.json');
	const jsonUrl = url.slice(0, jsonIndex + '.json'.length);
	// For seamless domains, fetch from the global layer's domain; cache under the
	// original (seamless) key so duplicate requests are still deduplicated.
	const fetchJsonUrl = resolveJsonFetchUrl(jsonUrl, domainOptions);

	if (!metaDataCache.has(jsonUrl)) {
		const metaRequest = fetch(fetchJsonUrl).then((response) => {
			if (!response.ok) {
				throw new Error(`Failed to fetch ${fetchJsonUrl}: ${response.status}`);
			}
			return response.json() as Promise<DomainMetaDataJson>;
		});
		// Evict failed fetches immediately so the next request retries instead of
		// hitting the cached rejection for the rest of the 60 seconds.
		metaRequest.catch(() => metaDataCache.delete(jsonUrl));
		metaDataCache.set(jsonUrl, metaRequest);
		setTimeout(() => metaDataCache.delete(jsonUrl), 60000); // delete after 60 seconds
	}
	const metaResult = await metaDataCache.get(jsonUrl)!;

	const { meta } = url.match(DOMAIN_META_REGEX)?.groups as {
		meta: string; // E.G. latest | in-progress
	};
	const modelRun = new Date(metaResult.reference_time);

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
				date = new Date(metaResult.valid_times[index]);
			} else {
				throw new Error('Missing valid times index');
			}
		}
	} else {
		// if no time_step defined, then take the first valid time
		date = new Date(metaResult.valid_times[0]);
	}
	parsedOmUrl.searchParams.delete('time_step'); // delete time_step urlSearchParam since it has no effect on map

	// need to return a URL that is not percent encoded
	return decodeURIComponent(
		'om://' +
			parsedOmUrl.href.replace(
				`${meta}.json`,
				`${modelRun.getUTCFullYear()}/${pad(modelRun.getUTCMonth() + 1)}/${pad(modelRun.getUTCDate())}/${pad(modelRun.getUTCHours())}00Z/${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}00.om`
			)
	);
};

export const normalizeUrl = async (url: string, domainOptions?: AnyDomain[]): Promise<string> => {
	if (url.includes('.json')) {
		return parseMetaJson(url, domainOptions);
	}
	return url;
};
