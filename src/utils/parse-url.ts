import { pad } from '.';
import { getConcreteDomainValue, isSeamlessDomain } from '../domain-helpers';

import {
	DATA_RELEVANT_PARAMS,
	DOMAIN_META_REGEX,
	OM_PREFIX_REGEX,
	RESOLVE_DOMAIN_REGEX,
	RUN_AND_VALID_TIME_REGEX,
	TILE_SUFFIX_REGEX,
	TIME_STEP_REGEX
} from './constants';

import { Domain, DomainMetaDataJson, ParsedUrlComponents, TileIndex } from '../types';

export const parseTileIndex = (
	url: string
): { tileIndex: TileIndex | null; remainingUrl: string } => {
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
 * Swaps the domain segment of an om file or metadata URL, wherever the path
 * puts it. Seamless composites only exist client-side: the server serves the
 * concrete sub-domains, so every request for a composite is issued under a
 * concrete domain's path.
 */
export const replaceUrlDomain = (
	url: string,
	fromDomainValue: string,
	toDomainValue: string
): string =>
	url.replace(RESOLVE_DOMAIN_REGEX, (segment: string, domain: string) =>
		domain === fromDomainValue ? toDomainValue + segment.slice(domain.length) : segment
	);

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
 * A seamless composite has no metadata of its own on the server; its base
 * layer's `{meta}.json` describes the composite.
 */
const resolveJsonFetchUrl = (jsonUrl: string, domainOptions?: Domain[]): string => {
	if (!domainOptions) return jsonUrl;
	// The meta regex, not RESOLVE_DOMAIN_REGEX: that one only matches `.om`
	// paths, so a `{meta}.json` URL would never be rewritten
	const urlDomainValue = jsonUrl.match(DOMAIN_META_REGEX)?.groups?.domain;
	if (!urlDomainValue) return jsonUrl;
	const domain = domainOptions.find((d) => d.value === urlDomainValue);
	if (!domain || !isSeamlessDomain(domain)) return jsonUrl;
	return replaceUrlDomain(jsonUrl, urlDomainValue, getConcreteDomainValue(domain));
};

/**
 * Length in hours of the time step ending at `validTime` in a run with these
 * valid times: the gap to the previous valid time, the first one taking the
 * gap to the next. This is the `delta_time_hours` a host puts on the om URL
 * for rules turning accumulations into rates. Undefined when `validTime` is
 * not a valid time of the run or the run has only one. The listed valid
 * times are not guaranteed to be in order.
 */
export const deltaTimeHoursAt = (
	validTime: Date,
	validTimes: (Date | string)[] | undefined
): number | undefined => {
	if (!validTimes || validTimes.length < 2) return undefined;
	const times = validTimes.map((time) => new Date(time).getTime()).sort((a, b) => a - b);
	const index = times.indexOf(validTime.getTime());
	if (index === -1) return undefined;
	const step = index === 0 ? times[1] - times[0] : times[index] - times[index - 1];
	return step / 3_600_000;
};

export const parseMetaJson = async (omUrl: string, domainOptions?: Domain[]) => {
	let date = new Date();
	const url = omUrl.replace('om://', '');

	// jsonUrl should be everything until ".json" of the current url (inclusive)
	const jsonIndex = url.indexOf('.json');
	const jsonUrl = url.slice(0, jsonIndex + '.json'.length);
	// For seamless domains, fetch from the base layer's domain; cache under the
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

	// A tile request carries its coordinates after the query (`...&variable=x/5/16/10`);
	// they come off while the query is edited, so a parameter added below does
	// not end up behind them, and go back on at the very end
	const tileSuffix = url.match(TILE_SUFFIX_REGEX)?.[0] ?? '';
	const parsedOmUrl = new URL(url.slice(0, url.length - tileSuffix.length));
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

	// The capture API already holds the run's valid times, so it sets the step
	// length rate rules divide by, for the file the URL resolves to (named by
	// the hour), unless the caller passed one. Reads without such a rule ignore it.
	if (!parsedOmUrl.searchParams.has('delta_time_hours')) {
		const fileTime = new Date(date);
		fileTime.setUTCMinutes(0, 0, 0);
		const step = deltaTimeHoursAt(fileTime, metaResult.valid_times);
		if (step) parsedOmUrl.searchParams.set('delta_time_hours', String(step));
	}

	// need to return a URL that is not percent encoded
	return decodeURIComponent(
		'om://' +
			parsedOmUrl.href.replace(
				`${meta}.json`,
				`${modelRun.getUTCFullYear()}/${pad(modelRun.getUTCMonth() + 1)}/${pad(modelRun.getUTCDate())}/${pad(modelRun.getUTCHours())}00Z/${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}00.om`
			) +
			tileSuffix
	);
};

export const normalizeUrl = async (url: string, domainOptions?: Domain[]): Promise<string> => {
	if (url.includes('.json')) {
		return parseMetaJson(url, domainOptions);
	}
	return url;
};
