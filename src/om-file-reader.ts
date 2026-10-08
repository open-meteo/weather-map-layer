import {
	BlockCache,
	LruBlockCache,
	OmDataType,
	OmFileReadOptions,
	type OmFileReader,
	OmHttpBackendPool
} from '@openmeteo/file-reader';

import { fastAtan2, radiansToDegrees } from './utils/math';
import {
	apparentTemperature,
	dewPoint,
	relativeHumidity,
	vapourPressureDeficit,
	wetBulbTemperature
} from './utils/meteorology';
import { fetchRunTimeStepHours } from './utils/parse-url';

import type { Data, DimensionRange } from './types';

/**
 * Configuration options for the WeatherMapLayerFileReader.
 */
export interface FileReaderConfig {
	/**
	 * Whether to read data into SharedArrayBuffers. SAB-backed values are shared
	 * zero-copy with the tile workers instead of being structured-cloned per
	 * tile request. @default true when SharedArrayBuffer is available (cross-origin
	 * isolated page or Node), false otherwise
	 */
	useSAB?: boolean;
	/** Number of retry attempts for failed requests. @default 2 */
	retries?: number;
	/** Whether to validate ETags for cache coherency. @default false */
	eTagValidation?: boolean;

	/**
	 * Block cache implementation to use.
	 * In the browser, pass a `BrowserBlockCache`.
	 * In Node, pass an `LruBlockCache` or any other `BlockCache<string>`.
	 * If omitted, falls back to an in-memory LruBlockCache.
	 */
	cache?: BlockCache<string | bigint>;

	/**
	 * Rules deriving a requested variable from the variables actually stored in
	 * the file (wind speed from u/v components, snowfall from its water
	 * equivalent). A rule matches the requested name and then decides against
	 * the file's variables whether it applies; the first matching rule that
	 * claims the name wins. The list replaces the defaults rather than
	 * extending them: spread `defaultDerivationRules` to keep them.
	 *
	 * Read once, when the protocol builds its shared reader: like the other
	 * `fileReaderConfig` fields, later changes are ignored.
	 *
	 * @default defaultDerivationRules
	 */
	derivationRules?: VariableDerivationRule[];
}

export const defaultFileReaderConfig: Required<
	Omit<FileReaderConfig, 'cache' | 'derivationRules'>
> = {
	useSAB: typeof SharedArrayBuffer !== 'undefined',
	retries: 2,
	eTagValidation: false
};

/** A rule that claimed the requested variable for one file, with what it reads. */
interface ResolvedDerivation {
	rule: VariableDerivationRule;
	sourceVars: string[];
	context: DerivationContext;
}

/**
 * Convenience class for reading from OM-files implementing some utility conversions during reading.
 */
export class WeatherMapLayerFileReader {
	readonly cache: BlockCache;
	readonly config: Required<Omit<FileReaderConfig, 'cache'>>;
	/** Memoizes one backend per URL, so repeat reads skip the HEAD request. */
	private readonly backendPool: OmHttpBackendPool;

	constructor(config: FileReaderConfig = {}) {
		this.config = {
			...defaultFileReaderConfig,
			...config,
			// Not in `defaultFileReaderConfig`: the default rules are declared further
			// down this module, after the helpers they are built from.
			derivationRules: config.derivationRules ?? defaultDerivationRules
		};

		// Use the injected cache, or fall back to an in-memory LRU cache
		this.cache = config.cache ?? new LruBlockCache(64 * 1024, 128);

		this.backendPool = new OmHttpBackendPool({
			backendOptions: {
				eTagValidation: this.config.eTagValidation,
				retries: this.config.retries
			}
		});
	}

	/**
	 * Run `fn` with a reader scoped to `omUrl`. The reader is opened for this
	 * call and disposed afterwards, so the class holds no file state: reads for
	 * different files can never interleave on a shared reader. The backend pool
	 * only memoizes per-URL HTTP metadata (no wasm resources), keeping repeat
	 * opens cheap without reintroducing shared reader state.
	 */
	private withReader<T>(omUrl: string, fn: (reader: OmFileReader) => Promise<T>): Promise<T> {
		return this.backendPool.withReader(omUrl, this.cache, fn);
	}

	private getRanges(ranges: DimensionRange[] | null, dimensions: number[]): DimensionRange[] {
		if (ranges) {
			return ranges;
		} else {
			return [
				{ start: 0, end: dimensions[0] },
				{ start: 0, end: dimensions[1] }
			];
		}
	}

	/**
	 * The first rule claiming `variable` for this file, or undefined when the
	 * variable is read as stored. Only rules whose pattern matches the name are
	 * asked, so a file is not listed for names no rule is interested in.
	 */
	private async resolveDerivation(
		reader: OmFileReader,
		omUrl: string,
		variable: string
	): Promise<ResolvedDerivation | undefined> {
		const candidates = this.config.derivationRules.filter((rule) =>
			patternMatches(rule.pattern, variable)
		);
		if (candidates.length === 0) return undefined;

		const [stored, timeStepHours] = await Promise.all([
			listRootVariables(reader),
			candidates.some((rule) => rule.usesTimeStep) ? fetchRunTimeStepHours(omUrl) : undefined
		]);
		const context: DerivationContext = { variable, stored, timeStepHours };

		for (const rule of candidates) {
			const sourceVars = rule.getSourceVars(context);
			if (sourceVars === null) continue;
			if (sourceVars.length === 0) {
				throw new Error(`Derivation rule for ${variable} returned no source variables`);
			}
			return { rule, sourceVars, context };
		}
		return undefined;
	}

	/** Read variable data using a derivation rule. */
	private async readWithDerivationRule(
		reader: OmFileReader,
		{ rule, sourceVars, context }: ResolvedDerivation,
		ranges: DimensionRange[] | null,
		signal?: AbortSignal
	): Promise<Data> {
		// Get readers for source variables (each can hit the network for its
		// metadata block, so resolve them concurrently). allSettled rather than
		// all, so a child created by one lookup still reaches the cleanup below
		// when a sibling lookup rejects.
		const results = await Promise.allSettled(
			sourceVars.map((sourceVar) => reader.getChildByName(sourceVar))
		);
		const sourceReaders = results.map((result) =>
			result.status === 'fulfilled' ? result.value : undefined
		);

		try {
			results.forEach((result, i) => {
				if (result.status === 'rejected') {
					throw result.reason;
				}
				if (!result.value) {
					throw new Error(`Source variable ${sourceVars[i]} not found`);
				}
			});

			// The first source variable defines the read geometry; a rule combines
			// variables of one file, which share their dimensions.
			const dimensions = sourceReaders[0]!.getDimensions();
			const readRanges = this.getRanges(ranges, dimensions);
			const readOptions: OmFileReadOptions<OmDataType.FloatArray> = {
				type: OmDataType.FloatArray,
				ranges: readRanges,
				intoSAB: this.config.useSAB,
				signal
			};

			const sourceData = await Promise.all(
				sourceReaders.map((sourceReader) => sourceReader!.read(readOptions))
			);

			// Process using the rule
			const data = rule.process(sourceData, context);

			// Every derivation rule defines its quantization scale factor so the
			// half-quantum threshold offset is always available. `'primary'` inherits
			// the first source variable's stored scale factor — exact when `values`
			// is that variable passed through unchanged (speed/direction, wave), and a
			// good proxy for derived magnitudes (wind speed from u/v).
			data.scaleFactor =
				rule.scaleFactor === 'primary' ? sourceReaders[0]!.scaleFactor() : rule.scaleFactor;

			return data;
		} finally {
			// Child readers hold their own wasm allocations; disposing the scoped
			// root reader does not free them.
			sourceReaders.forEach((sourceReader) => sourceReader?.dispose());
		}
	}

	/**
	 * Read a single variable directly (no derivation).
	 */
	private async readSimpleVariable(
		reader: OmFileReader,
		variable: string,
		ranges: DimensionRange[] | null,
		signal?: AbortSignal
	): Promise<Data> {
		const variableReader = await reader.getChildByName(variable);
		if (!variableReader) {
			throw new Error(`Variable: ${variable} not found`);
		}

		try {
			const dimensions = variableReader.getDimensions();
			const readRanges = this.getRanges(ranges, dimensions);

			const values = (await variableReader.read({
				type: OmDataType.FloatArray,
				ranges: readRanges,
				intoSAB: this.config.useSAB,
				signal
			})) as Float32Array;

			return { values, directions: undefined, scaleFactor: variableReader.scaleFactor() };
		} finally {
			variableReader.dispose();
		}
	}

	/**
	 * Read a specific variable from the given .om file. Implements on the fly
	 * conversion for some variables, e.g. uv components are converted to speed
	 * and direction. Selecting the file and reading from it is a single atomic
	 * step, so concurrent reads of different files cannot interleave.
	 *
	 * @param omUrl The .om file URL to read from.
	 * @param variable The variable to read.
	 * @param ranges The ranges to read. If null, all dimensions are read.
	 * @param signal Optional AbortSignal
	 * @returns Promise resolving to data object containing values and optional directions
	 */
	async readVariable(
		omUrl: string,
		variable: string,
		ranges: DimensionRange[] | null = null,
		signal?: AbortSignal
	): Promise<Data> {
		return this.withReader(omUrl, async (reader) => {
			const derivation = await this.resolveDerivation(reader, omUrl, variable);

			if (derivation) {
				return this.readWithDerivationRule(reader, derivation, ranges, signal);
			} else {
				return this.readSimpleVariable(reader, variable, ranges, signal);
			}
		});
	}

	/**
	 * Prefetch data for a specific variable and range of the given .om file into
	 * the local cache. This is useful for warming up the cache for anticipated
	 * map movements or timestep changes.
	 */
	async prefetchVariable(
		omUrl: string,
		variable: string,
		ranges: DimensionRange[] | null = null,
		signal?: AbortSignal
	): Promise<void> {
		await this.withReader(omUrl, async (reader) => {
			const derivation = await this.resolveDerivation(reader, omUrl, variable);
			const varsToPrefetch = derivation ? derivation.sourceVars : [variable];

			await Promise.all(
				varsToPrefetch.map(async (v) => {
					const variableReader = await reader.getChildByName(v);
					if (!variableReader) return;

					try {
						const dimensions = variableReader.getDimensions();
						const readRanges = this.getRanges(ranges, dimensions);

						// readPrefetch warms up the backend cache by requesting the necessary
						// data blocks without decoding them or copying them to a TypedArray.
						await variableReader.readPrefetch({
							prefetchConcurrency: 1000, // concurrency limiting on requests is executed via the BlockCache
							ranges: readRanges,
							signal
						});
					} finally {
						variableReader.dispose();
					}
				})
			);
		});
	}

	/**
	 * Warm the cache for the given .om file: opening the scoped reader fetches
	 * the file header/trailer and root metadata into the block cache, so a later
	 * read only pays for its data blocks. No variable data is requested.
	 */
	async warmFile(omUrl: string): Promise<void> {
		await this.withReader(omUrl, async () => {});
	}

	/** Drop all memoized backends, forcing fresh HEAD metadata requests. */
	clearBackends(): void {
		this.backendPool.clear();
	}
}

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
	 * variables (precipitation sums) cover. Only looked up for rules with
	 * `usesTimeStep`, from the model run's `meta.json` next to the file;
	 * undefined when the file is not part of such a run.
	 */
	timeStepHours?: number;
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
	 * What `process` fills in, declared up front because consumers decide
	 * whether to offer arrows for a variable before any data is read. `barbs`
	 * marks the values as a wind speed: barbs encode knots, so a variable
	 * whose directions come with another quantity (wave height in metres,
	 * current speed) is drawn with arrows only.
	 */
	provides: { directions: boolean; barbs: boolean };

	/**
	 * Whether the rule needs the file's time step (`context.timeStepHours`).
	 * The step comes from the model run's `meta.json`, one request per run,
	 * so only rules turning accumulations into rates ask for it.
	 */
	usesTimeStep?: boolean;

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
const patternMatches = (pattern: string | RegExp, variable: string): boolean =>
	typeof pattern === 'string' ? variable.includes(pattern) : variable.search(pattern) !== -1;

/** First rule whose pattern matches the variable name, if any. */
const findDerivationRule = (
	variable: string,
	rules: VariableDerivationRule[]
): VariableDerivationRule | undefined =>
	rules.find((rule) => patternMatches(rule.pattern, variable));

/**
 * Names of the variables at the root of the file. Their metadata sits in a
 * few blocks at the end of the file that a lookup by name walks anyway, so
 * after the first read of a file this is a pass over cached blocks.
 */
const listRootVariables = async (reader: OmFileReader): Promise<Set<string>> => {
	const names = new Set<string>();
	const count = reader.numberOfChildren();
	for (let i = 0; i < count; i++) {
		const child = await reader.getChild(i);
		if (!child) continue;
		try {
			const name = child.getName();
			if (name) names.add(name);
		} finally {
			child.dispose();
		}
	}
	return names;
};

/**
 * Whether reading `variable` yields a direction field, i.e. whether arrows
 * can be rendered for it. Uses the same rule lookup as the reader, so a UI
 * offering arrows stays in step with what the data can provide.
 */
export const variableHasDirections = (
	variable: string,
	rules: VariableDerivationRule[] = defaultDerivationRules
): boolean => findDerivationRule(variable, rules)?.provides.directions ?? false;

/**
 * Whether `variable` can be drawn as station-model wind barbs: its values
 * must be a wind speed, since barbs encode knots.
 */
export const variableSupportsBarbs = (
	variable: string,
	rules: VariableDerivationRule[] = defaultDerivationRules
): boolean => findDerivationRule(variable, rules)?.provides.barbs ?? false;

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
 * SAB-backed result, so it stays zero-copy for the tile workers.
 */
const mapCells = (source: Float32Array, cell: (i: number) => number): Float32Array => {
	const BufferConstructor = source.buffer.constructor as typeof ArrayBuffer;
	const values = new Float32Array(new BufferConstructor(source.byteLength));
	for (let i = 0; i < source.length; i++) {
		values[i] = cell(i);
	}
	return values;
};

const scalar = { directions: false, barbs: false };

/**
 * Temperature and humidity sources of the 2 m humidity-derived fields: the
 * relative humidity where stored, otherwise the dew point some models (ECMWF)
 * store instead, which `relativeHumidityAt` turns back into humidity.
 */
const humiditySources = (stored: ReadonlySet<string>): string[] | null =>
	allStored(stored, [
		'temperature_2m',
		stored.has('relative_humidity_2m') ? 'relative_humidity_2m' : 'dew_point_2m'
	]);

/**
 * Shortwave radiation sources: the sum where stored, otherwise the direct and
 * diffuse parts some models (DWD ICON) store instead, which `shortwaveAt`
 * adds up.
 */
const shortwaveSources = (stored: ReadonlySet<string>): string[] | null =>
	allStored(
		stored,
		stored.has('shortwave_radiation')
			? ['shortwave_radiation']
			: ['direct_radiation', 'diffuse_radiation']
	);

/** Shortwave radiation of cell `i` from the sources `shortwaveSources` chose. */
const shortwaveAt = (radiation: Float32Array[], i: number): number =>
	radiation.length === 2 ? radiation[0][i] + radiation[1][i] : radiation[0][i];

/** Relative humidity of cell `i` from the sources `humiditySources` chose. */
const relativeHumidityAt = (
	stored: ReadonlySet<string>,
	temperature: Float32Array,
	humidity: Float32Array,
	i: number
): number =>
	stored.has('relative_humidity_2m') ? humidity[i] : relativeHumidity(temperature[i], humidity[i]);

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
		process: ([height, direction]) => ({
			values: height,
			directions: direction
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

	// Precipitation per hour from the per-step sums the files store, so a
	// series of maps reads the same across a model's hourly, 3-hourly and
	// 6-hourly steps. Needs the length of the step, hence `usesTimeStep`.
	{
		pattern: /^(?:precipitation|rain|showers)_rate$/,
		provides: scalar,
		usesTimeStep: true,
		// The sum's quantum divided by the step length has no fixed value; a
		// 0.01 mm/h grid keeps the threshold offset negligible.
		scaleFactor: 100,
		getSourceVars: ({ variable, stored, timeStepHours }) => {
			const sum = variable.replace(/_rate$/, '');
			if (!stored.has(sum)) return null;
			if (!timeStepHours) {
				throw new Error(
					`${variable} needs the model run's meta.json for the length of the time step`
				);
			}
			return [sum];
		},
		process: ([sum], { timeStepHours }) => ({
			values: mapCells(sum, (i) => sum[i] / timeStepHours!),
			directions: undefined
		})
	},

	// Humidity-derived fields the API never stores, from the 2 m temperature
	// and humidity (relative humidity, or the dew point where a model stores
	// that instead).
	{
		pattern: /^vapour_pressure_deficit$/,
		provides: scalar,
		// kPa from a nonlinear formula, so no exact quantum exists; a 0.01 kPa
		// step keeps the threshold offset negligible.
		scaleFactor: 100,
		getSourceVars: ({ stored }) => humiditySources(stored),
		process: ([temperature, humidity], { stored }) => ({
			values: mapCells(temperature, (i) =>
				vapourPressureDeficit(
					temperature[i],
					dewPoint(temperature[i], relativeHumidityAt(stored, temperature, humidity, i))
				)
			),
			directions: undefined
		})
	},
	{
		pattern: /^wet_bulb_temperature_2m$/,
		provides: scalar,
		// A temperature in °C, so the air temperature's stored step applies.
		scaleFactor: 'primary',
		getSourceVars: ({ stored }) => humiditySources(stored),
		process: ([temperature, humidity], { stored }) => ({
			values: mapCells(temperature, (i) =>
				wetBulbTemperature(temperature[i], relativeHumidityAt(stored, temperature, humidity, i))
			),
			directions: undefined
		})
	},
	{
		pattern: /^apparent_temperature$/,
		provides: scalar,
		scaleFactor: 'primary',
		// The 10 m wind as u/v components or, on models storing it so, as speed,
		// and the radiation as a sum or as its parts; the first file of a run
		// has no radiation yet.
		getSourceVars: ({ stored }) => {
			const humidity = humiditySources(stored);
			const radiation = shortwaveSources(stored);
			if (!humidity || !radiation) return null;
			const wind = stored.has('wind_speed_10m')
				? ['wind_speed_10m']
				: ['wind_u_component_10m', 'wind_v_component_10m'];
			return allStored(stored, [...humidity, ...wind, ...radiation]);
		},
		process: ([temperature, humidity, ...rest], { stored }) => {
			const wind = rest.splice(0, stored.has('wind_speed_10m') ? 1 : 2);
			const windSpeedAt =
				wind.length === 2
					? (i: number) => Math.sqrt(wind[0][i] * wind[0][i] + wind[1][i] * wind[1][i])
					: (i: number) => wind[0][i];
			return {
				values: mapCells(temperature, (i) =>
					apparentTemperature(
						temperature[i],
						relativeHumidityAt(stored, temperature, humidity, i),
						windSpeedAt(i),
						shortwaveAt(rest, i)
					)
				),
				directions: undefined
			};
		}
	}
];
