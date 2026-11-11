/**
 * Derivation rules: how a requested variable is read from the variables a
 * file actually stores (wind speed from the `u`/`v` components, snowfall from
 * its water equivalent, the humidity-derived fields from temperature and
 * humidity). The reader asks the rules matching a name in order; the first
 * one that claims the name for the file at hand wins, and when none does the
 * variable is read as stored.
 */
import { fastAtan2, radiansToDegrees } from './utils/math';
import {
	apparentTemperature,
	dewPoint,
	relativeHumidity,
	vapourPressureDeficit,
	wetBulbTemperature
} from './utils/meteorology';

import type { Data, Domain } from './types';

/**
 * What a derivation rule gets to see of the file it reads from.
 */
export interface DerivationContext {
	/** The requested variable name. */
	variable: string;

	/**
	 * Names of the variables stored in the file. What a model stores differs
	 * per domain and per time step: snowfall is stored by some models and
	 * derivable from its water equivalent on others, wind comes as `u`/`v`
	 * components or as speed and direction, and the first file of a run has no
	 * accumulations yet.
	 */
	stored: ReadonlySet<string>;

	/**
	 * Length of the file's time step in hours, the period its accumulated
	 * variables (precipitation sums) cover. Passed in by the reader's caller:
	 * the om protocol passes on the `delta_time_hours` parameter of the om
	 * URL, which the host application sets from the run's valid times for a
	 * variable that needs it (`variableUsesDeltaTime`). Undefined when the
	 * caller passed none, which the reader rejects for such a variable.
	 */
	deltaTimeHours?: number;

	/**
	 * The domain the file belongs to, where the caller knows it: the om
	 * protocol resolves it from the URL. Rules consult it for per-model
	 * storage conventions such as `wave_directions_towards`.
	 */
	domain?: Domain;
}

/**
 * Rule for deriving values and directions from the variables stored in a file.
 */
export interface VariableDerivationRule {
	/**
	 * Matches the requested variable name: a string anywhere in the name, a
	 * RegExp by search. Anchor it when the name is also the start of a stored
	 * variable (`/^snowfall$/` next to `snowfall_water_equivalent`). Several
	 * rules may match one name, each claiming it for different files; they
	 * have to agree on `provides`, which is answered from the first match
	 * before any file is open.
	 */
	pattern: string | RegExp;

	/**
	 * What reading a matched variable yields, known before any data is read:
	 * `directions` makes it eligible for arrows, `barbs` additionally marks the
	 * values as a wind speed (barbs encode knots), so other direction-carrying
	 * quantities (waves, currents) always draw plain arrows.
	 */
	provides: { directions: boolean; barbs: boolean };

	/**
	 * Whether the rule needs the file's time step (`context.deltaTimeHours`);
	 * the reader's caller has to provide it for such a variable. Not needed
	 * for the precipitation family, which the reader turns into hourly rates
	 * itself after any rule (`variableIsAccumulated`).
	 */
	usesDeltaTime?: boolean;

	/**
	 * Names of the variables in the file that the requested variable is read
	 * from, in the order `process` expects them, or `null` when the rule does
	 * not apply to this file: the next matching rule is asked, and when none
	 * claims the name the variable is read as stored. The sources must share
	 * their dimensions. A rule for a name that some models store checks
	 * `stored` for the name itself, so the stored field wins.
	 */
	getSourceVars: (context: DerivationContext) => string[] | null;

	/**
	 * Quantization scale factor of the derived `values`, so a half-quantum
	 * threshold offset can be applied. `'primary'` uses the first source
	 * variable's stored scale factor; a number sets a fixed factor.
	 */
	scaleFactor: number | 'primary';

	/**
	 * Process the raw data from the source variables into values and directions.
	 * Plain arrays are fine: where the reader uses SharedArrayBuffers, it moves
	 * the output into one.
	 * @param sources - Data per source variable, in `getSourceVars` order
	 * @param context - The file the sources came from, as `getSourceVars` saw it
	 * @returns Data object with values and optional directions
	 */
	process: (sources: Float32Array[], context: DerivationContext) => Data;
}

/**
 * Whether a rule's pattern matches the name. `search` rather than `test` for
 * a RegExp: with the `g` or `y` flag `test` keeps its `lastIndex` between
 * calls, so the same rule would match only every other lookup.
 */
export const patternMatches = (pattern: string | RegExp, variable: string): boolean =>
	typeof pattern === 'string' ? variable.includes(pattern) : variable.search(pattern) !== -1;

/** First rule whose pattern matches the variable name, if any. */
const findDerivationRule = (
	variable: string,
	rules: VariableDerivationRule[]
): VariableDerivationRule | undefined =>
	rules.find((rule) => patternMatches(rule.pattern, variable));

/**
 * Whether reading `variable` yields a direction field, i.e. whether arrows
 * can be drawn for it. Answered from the first matching rule; a rule only
 * matching some files has to agree with the others on `provides`.
 */
export const variableHasDirections = (
	variable: string,
	rules: VariableDerivationRule[] = defaultDerivationRules
): boolean => findDerivationRule(variable, rules)?.provides.directions ?? false;

/**
 * Whether `variable` is a wind speed with directions, i.e. whether wind barbs
 * (which encode speed in knots) are meaningful for it.
 */
export const variableSupportsBarbs = (
	variable: string,
	rules: VariableDerivationRule[] = defaultDerivationRules
): boolean => findDerivationRule(variable, rules)?.provides.barbs ?? false;

/**
 * The precipitation family the files store as sums over each time step, with
 * the ensemble mean and spread of those sums. The reader always returns them
 * per hour, stored or derived, so a series of maps reads the same across a
 * model's hourly, 3-hourly and 6-hourly steps.
 */
const ACCUMULATED =
	/^(?:precipitation|rain|showers|snowfall|snowfall_water_equivalent)(?:_mean|_spread)?$/;

/** Whether the reader turns `variable` from a per-step sum into an hourly rate. */
export const variableIsAccumulated = (variable: string): boolean => ACCUMULATED.test(variable);

/**
 * Whether reading `variable` needs the file's time step: an accumulated
 * variable, or a rule matching it that asks for the step (which rule claims
 * the name depends on the file, so a host sets the step whenever any
 * candidate asks for it).
 */
export const variableUsesDeltaTime = (
	variable: string,
	rules: VariableDerivationRule[] = defaultDerivationRules
): boolean =>
	variableIsAccumulated(variable) ||
	rules.some((rule) => rule.usesDeltaTime && patternMatches(rule.pattern, variable));

/**
 * Whether `variable` can be read from a file storing the variables in
 * `stored`: as stored, or through a rule claiming it for that set. Lets a UI
 * offer the derived variables a domain's metadata does not list, by the same
 * decision the reader makes for the file.
 */
export const variableAvailable = (
	variable: string,
	stored: ReadonlySet<string>,
	rules: VariableDerivationRule[] = defaultDerivationRules
): boolean =>
	stored.has(variable) ||
	rules.some(
		(rule) =>
			patternMatches(rule.pattern, variable) && rule.getSourceVars({ variable, stored }) !== null
	);

/** Vector magnitude and meteorological direction from u/v components. */
const uvToSpeedAndDirection = ([u, v]: Float32Array[]): Data => {
	const BufferConstructor = u.buffer.constructor as typeof ArrayBuffer;
	const values = new Float32Array(new BufferConstructor(u.byteLength));
	const directions = new Float32Array(new BufferConstructor(u.byteLength));

	for (let i = 0; i < u.length; i++) {
		values[i] = Math.sqrt(u[i] * u[i] + v[i] * v[i]);
		directions[i] = (radiansToDegrees(fastAtan2(u[i], v[i])) + 180) % 360;
	}

	return { values, directions };
};

/** `names` when the file stores all of them, else null: the rule passes. */
const allStored = (stored: ReadonlySet<string>, names: string[]): string[] | null =>
	names.every((name) => stored.has(name)) ? names : null;

/**
 * Sources for a name the API computes only where a model does not store it:
 * the stored field wins, otherwise every source has to be in the file.
 */
const unlessStored = ({ variable, stored }: DerivationContext, names: string[]): string[] | null =>
	stored.has(variable) ? null : allStored(stored, names);

/** Rule for `_u_<postfix>` / `_v_<postfix>` pairs: each name maps to its sibling. */
const uvRule = (postfix: string, barbs: boolean): VariableDerivationRule => ({
	pattern: new RegExp(`_[uv]_${postfix}`),
	provides: { directions: true, barbs },
	// Derived magnitude; the u-component's stored scale factor is a good proxy
	// for the speed's quantization step.
	scaleFactor: 'primary',
	getSourceVars: ({ variable, stored }) =>
		allStored(stored, [
			variable.replace(`_v_${postfix}`, `_u_${postfix}`),
			variable.replace(`_u_${postfix}`, `_v_${postfix}`)
		]),
	process: uvToSpeedAndDirection
});

const SPEED_OR_DIRECTION = /_(?:speed|direction)_/;

/**
 * Output array of the source's buffer kind: SAB-backed sources give a
 * SAB-backed result, so there is nothing to copy for the tile workers.
 */
const mapCells = (source: Float32Array, cell: (i: number) => number): Float32Array => {
	const BufferConstructor = source.buffer.constructor as typeof ArrayBuffer;
	const values = new Float32Array(new BufferConstructor(source.byteLength));
	for (let i = 0; i < source.length; i++) {
		values[i] = cell(i);
	}
	return values;
};

/** Each direction turned by 180°, into 0..360 whatever range the stored values use. */
const oppositeDirections = (directions: Float32Array): Float32Array =>
	mapCells(directions, (i) => (((directions[i] + 180) % 360) + 360) % 360);

const scalar = { directions: false, barbs: false };

/** A per-cell view on one or more source fields. */
type CellAccessor = (i: number) => number;

/**
 * Temperature and humidity sources of the 2 m humidity-derived fields: the
 * relative humidity where stored, otherwise the dew point some models (ECMWF)
 * store instead.
 */
const humiditySources = (stored: ReadonlySet<string>): string[] | null =>
	allStored(stored, [
		'temperature_2m',
		stored.has('relative_humidity_2m') ? 'relative_humidity_2m' : 'dew_point_2m'
	]);

/**
 * Relative humidity per cell from the sources `humiditySources` chose: as
 * stored, or recovered from the stored dew point. Chosen once per read.
 */
const humidityAccessor = (
	stored: ReadonlySet<string>,
	temperature: Float32Array,
	humidityOrDewPoint: Float32Array
): CellAccessor =>
	stored.has('relative_humidity_2m')
		? (i) => humidityOrDewPoint[i]
		: (i) => relativeHumidity(temperature[i], humidityOrDewPoint[i]);

/** Dew point per cell from the same sources: as stored, or from the humidity. */
const dewPointAccessor = (
	stored: ReadonlySet<string>,
	temperature: Float32Array,
	humidityOrDewPoint: Float32Array
): CellAccessor =>
	stored.has('relative_humidity_2m')
		? (i) => dewPoint(temperature[i], humidityOrDewPoint[i])
		: (i) => humidityOrDewPoint[i];

/** The 10 m wind: its speed where a model stores that, else the u/v components. */
const windSources = (stored: ReadonlySet<string>): string[] =>
	stored.has('wind_speed_10m')
		? ['wind_speed_10m']
		: ['wind_u_component_10m', 'wind_v_component_10m'];

/**
 * Shortwave radiation sources: the sum where stored, otherwise the direct and
 * diffuse parts some models (DWD ICON) store instead, and nothing for a file
 * storing neither.
 */
const shortwaveSources = (stored: ReadonlySet<string>): string[] =>
	stored.has('shortwave_radiation')
		? ['shortwave_radiation']
		: (allStored(stored, ['direct_radiation', 'diffuse_radiation']) ?? []);

/**
 * Default derivation rules for common meteorological variables. Spread into a
 * custom `fileReaderConfig.derivationRules` list to keep them alongside own
 * rules.
 */
export const defaultDerivationRules: VariableDerivationRule[] = [
	// Wind components -> speed and direction
	uvRule('component', true),

	// Ocean currents -> speed and direction
	uvRule('current', false),

	// Wind speed/direction pairs stored as such
	{
		pattern: SPEED_OR_DIRECTION,
		provides: { directions: true, barbs: true },
		scaleFactor: 'primary',
		getSourceVars: ({ variable, stored }) =>
			allStored(stored, [
				variable.replace('_direction_', '_speed_'),
				variable.replace('_speed_', '_direction_')
			]),
		process: ([speed, direction]) => ({
			values: speed,
			directions: direction
		})
	},

	// Wind speed/direction names on models that store the u/v components
	// instead, so `wind_speed_10m` works on every model
	{
		pattern: SPEED_OR_DIRECTION,
		provides: { directions: true, barbs: true },
		scaleFactor: 'primary',
		getSourceVars: ({ variable, stored }) =>
			allStored(stored, [
				variable.replace(SPEED_OR_DIRECTION, '_u_component_'),
				variable.replace(SPEED_OR_DIRECTION, '_v_component_')
			]),
		process: uvToSpeedAndDirection
	},

	// Wave height and direction
	{
		pattern: /wave_(?:height|direction)/,
		provides: { directions: true, barbs: false },
		scaleFactor: 'primary',
		getSourceVars: ({ variable, stored }) =>
			allStored(stored, [
				variable.replace('wave_direction', 'wave_height'),
				variable.replace('wave_height', 'wave_direction')
			]),
		process: ([height, direction], { domain }) => ({
			values: height,
			directions: domain?.wave_directions_towards ? oppositeDirections(direction) : direction
		})
	},

	// Fields the API computes where a model does not store them, with the
	// API's formulas so a map matches the forecast endpoint. The stored field
	// wins where there is one, and a derived field needs all of its sources
	// stored: the first file of a run has no accumulations yet.
	{
		pattern: /^snowfall$/,
		provides: scalar,
		// cm of fresh snow from mm of water at a fixed ratio, so the water
		// equivalent's quantization step is within a factor of the snowfall's.
		scaleFactor: 'primary',
		getSourceVars: (context) => unlessStored(context, ['snowfall_water_equivalent']),
		process: ([waterEquivalent]) => ({
			values: mapCells(waterEquivalent, (i) => waterEquivalent[i] * 0.7),
			directions: undefined
		})
	},
	{
		pattern: /^rain$/,
		provides: scalar,
		scaleFactor: 'primary',
		// Showers are subtracted only where a model stores them
		getSourceVars: (context) =>
			unlessStored(context, [
				'precipitation',
				'snowfall_water_equivalent',
				...(context.stored.has('showers') ? ['showers'] : [])
			]),
		process: ([precipitation, snowWater, showers]) => ({
			values: mapCells(precipitation, (i) => {
				const convective = showers && !Number.isNaN(showers[i]) ? showers[i] : 0;
				return Math.max(precipitation[i] - snowWater[i] - convective, 0);
			}),
			directions: undefined
		})
	},
	{
		pattern: /^dew_point_2m$/,
		provides: scalar,
		scaleFactor: 'primary',
		getSourceVars: (context) => unlessStored(context, ['temperature_2m', 'relative_humidity_2m']),
		process: ([temperature, humidity]) => ({
			values: mapCells(temperature, (i) => dewPoint(temperature[i], humidity[i])),
			directions: undefined
		})
	},
	{
		pattern: /^relative_humidity_2m$/,
		provides: scalar,
		// Percent; the 1 % quantum the models store humidity in
		scaleFactor: 1,
		getSourceVars: (context) => unlessStored(context, ['temperature_2m', 'dew_point_2m']),
		process: ([temperature, dewPointTemperature]) => ({
			values: mapCells(temperature, (i) =>
				relativeHumidity(temperature[i], dewPointTemperature[i])
			),
			directions: undefined
		})
	},
	{
		pattern: /^diffuse_radiation$/,
		provides: scalar,
		scaleFactor: 'primary',
		getSourceVars: (context) => unlessStored(context, ['shortwave_radiation', 'direct_radiation']),
		process: ([shortwave, direct]) => ({
			values: mapCells(shortwave, (i) => Math.max(shortwave[i] - direct[i], 0)),
			directions: undefined
		})
	},
	{
		pattern: /^direct_radiation$/,
		provides: scalar,
		scaleFactor: 'primary',
		getSourceVars: (context) => unlessStored(context, ['shortwave_radiation', 'diffuse_radiation']),
		process: ([shortwave, diffuse]) => ({
			values: mapCells(shortwave, (i) => Math.max(shortwave[i] - diffuse[i], 0)),
			directions: undefined
		})
	},
	{
		pattern: /^shortwave_radiation$/,
		provides: scalar,
		scaleFactor: 'primary',
		getSourceVars: (context) => unlessStored(context, ['direct_radiation', 'diffuse_radiation']),
		process: ([direct, diffuse]) => ({
			values: mapCells(direct, (i) => direct[i] + diffuse[i]),
			directions: undefined
		})
	},

	// Humidity-derived fields the API never stores, from the 2 m temperature
	// and humidity (relative humidity, or the dew point where a model stores
	// that instead). What the second source is gets decided from `stored`
	// once per read, so the per-cell loops stay plain arithmetic.
	{
		pattern: /^vapour_pressure_deficit$/,
		provides: scalar,
		// kPa from a nonlinear formula, so no exact quantum exists; a 0.01 kPa
		// step keeps the threshold offset negligible.
		scaleFactor: 100,
		getSourceVars: ({ stored }) => humiditySources(stored),
		process: ([temperature, humidityOrDewPoint], { stored }) => {
			const dewPointAt = dewPointAccessor(stored, temperature, humidityOrDewPoint);
			return {
				values: mapCells(temperature, (i) => vapourPressureDeficit(temperature[i], dewPointAt(i))),
				directions: undefined
			};
		}
	},
	{
		pattern: /^wet_bulb_temperature_2m$/,
		provides: scalar,
		// A temperature in °C, so the air temperature's stored step applies.
		scaleFactor: 'primary',
		getSourceVars: ({ stored }) => humiditySources(stored),
		process: ([temperature, humidityOrDewPoint], { stored }) => {
			const humidityAt = humidityAccessor(stored, temperature, humidityOrDewPoint);
			return {
				values: mapCells(temperature, (i) => wetBulbTemperature(temperature[i], humidityAt(i))),
				directions: undefined
			};
		}
	},
	{
		pattern: /^apparent_temperature$/,
		provides: scalar,
		scaleFactor: 'primary',
		// Temperature and humidity (or the dew point), the 10 m wind as speed
		// or as u/v components, and the radiation as a sum, as its direct and
		// diffuse parts, or not at all: a file storing none, like the first one
		// of a run, counts none, as the API does.
		getSourceVars: ({ stored }) => {
			const humidity = humiditySources(stored);
			return (
				humidity &&
				allStored(stored, [...humidity, ...windSources(stored), ...shortwaveSources(stored)])
			);
		},
		// The sources arrive in `getSourceVars` order; `stored` tells which
		// fields they are, the same way it chose them.
		process: (sources, { stored }) => {
			const [temperature, humidityOrDewPoint, ...rest] = sources;
			const humidityAt = humidityAccessor(stored, temperature, humidityOrDewPoint);

			const [windSpeed, u, v] = stored.has('wind_speed_10m')
				? [rest[0], undefined, undefined]
				: [undefined, rest[0], rest[1]];
			const windSpeedAt: CellAccessor = windSpeed
				? (i) => windSpeed[i]
				: (i) => Math.sqrt(u![i] * u![i] + v![i] * v![i]);

			const radiation = rest.slice(windSpeed ? 1 : 2);
			const [shortwave, direct, diffuse] = stored.has('shortwave_radiation')
				? [radiation[0], undefined, undefined]
				: [undefined, radiation[0], radiation[1]];
			const radiationAt: CellAccessor = shortwave
				? (i) => shortwave[i]
				: direct && diffuse
					? (i) => direct[i] + diffuse[i]
					: () => 0;

			return {
				values: mapCells(temperature, (i) =>
					apparentTemperature(temperature[i], humidityAt(i), windSpeedAt(i), radiationAt(i))
				),
				directions: undefined
			};
		}
	}
];
