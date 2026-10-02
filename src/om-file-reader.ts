import {
	BlockCache,
	LruBlockCache,
	OmDataType,
	OmFileReadOptions,
	type OmFileReader,
	OmHttpBackendPool
} from '@openmeteo/file-reader';

import { fastAtan2, radiansToDegrees } from './utils/math';

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
	 * equivalent). The first rule whose pattern matches wins, so the list
	 * replaces the defaults rather than extending them: spread
	 * `defaultDerivationRules` to keep them.
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

/**
 * Convenience class for reading from OM-files implementing some utility conversions during reading.
 */
export class WeatherMapLayerFileReader {
	readonly cache: BlockCache;
	readonly config: Required<Omit<FileReaderConfig, 'cache' | 'derivationRules'>>;
	readonly derivationRules: VariableDerivationRule[];
	/** Memoizes one backend per URL, so repeat reads skip the HEAD request. */
	private readonly backendPool: OmHttpBackendPool;

	constructor(config: FileReaderConfig = {}) {
		this.config = {
			...defaultFileReaderConfig,
			...config
		};

		this.derivationRules = config.derivationRules ?? defaultDerivationRules;

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

	/** Read variable data using a derivation rule. */
	private async readWithDerivationRule(
		reader: OmFileReader,
		variable: string,
		rule: VariableDerivationRule,
		ranges: DimensionRange[] | null,
		signal?: AbortSignal
	): Promise<Data> {
		const sourceVars = rule.getSourceVars(variable);
		if (sourceVars.length === 0) {
			throw new Error(`Derivation rule for ${variable} returned no source variables`);
		}

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
			const data = rule.process(sourceData);

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
		return this.withReader(omUrl, (reader) => {
			const derivationRule = findDerivationRule(variable, this.derivationRules);

			if (derivationRule) {
				return this.readWithDerivationRule(reader, variable, derivationRule, ranges, signal);
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
			const derivationRule = findDerivationRule(variable, this.derivationRules);
			const varsToPrefetch = derivationRule ? derivationRule.getSourceVars(variable) : [variable];

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
 * Rule for deriving values and directions from the variables stored in a file.
 */
export interface VariableDerivationRule {
	/** Pattern to match variable names (string or RegExp) */
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
	 * Names of the variables in the file that the requested variable is derived
	 * from, in the order `process` expects them. All of them must exist in the
	 * file, and they must share their dimensions.
	 */
	getSourceVars: (variable: string) => string[];

	/**
	 * Quantization scale factor of the derived `values`, so a half-quantum
	 * threshold offset can be applied. `'primary'` uses the first source
	 * variable's stored scale factor; a number sets a fixed factor.
	 */
	scaleFactor: number | 'primary';

	/**
	 * Process the raw data from the source variables into values and directions.
	 * @param sources - Data per source variable, in `getSourceVars` order
	 * @returns Data object with values and optional directions
	 */
	process: (sources: Float32Array[]) => Data;
}

/** First rule whose pattern matches the variable name, if any. */
const findDerivationRule = (
	variable: string,
	rules: VariableDerivationRule[]
): VariableDerivationRule | undefined =>
	rules.find((rule) =>
		typeof rule.pattern === 'string' ? variable.includes(rule.pattern) : rule.pattern.test(variable)
	);

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

/** Rule for `_u_<postfix>` / `_v_<postfix>` pairs: each name maps to its sibling. */
const uvRule = (postfix: string, barbs: boolean): VariableDerivationRule => ({
	pattern: new RegExp(`_[uv]_${postfix}`),
	provides: { directions: true, barbs },
	// Derived magnitude; the u-component's stored scale factor is a good proxy
	// for the speed's quantization step.
	scaleFactor: 'primary',
	getSourceVars: (variable: string) => [
		variable.replace(`_v_${postfix}`, `_u_${postfix}`),
		variable.replace(`_u_${postfix}`, `_v_${postfix}`)
	],
	process: uvToSpeedAndDirection
});

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

	// Wind speed/direction pairs (already stored separately)
	{
		pattern: /_(?:speed|direction)_/,
		provides: { directions: true, barbs: true },
		scaleFactor: 'primary',
		getSourceVars: (variable: string) => [
			variable.includes('_speed_') ? variable : variable.replace('_direction_', '_speed_'),
			variable.includes('_direction_') ? variable : variable.replace('_speed_', '_direction_')
		],
		process: ([speed, direction]: Float32Array[]) => ({
			values: speed,
			directions: direction
		})
	},

	// Wave height and direction
	{
		pattern: /wave_(?:height|direction)/,
		provides: { directions: true, barbs: false },
		scaleFactor: 'primary',
		getSourceVars: (variable: string) => [
			variable.replace('wave_direction', 'wave_height'),
			variable.replace('wave_height', 'wave_direction')
		],
		process: ([height, direction]: Float32Array[]) => ({
			values: height,
			directions: direction
		})
	}
];
