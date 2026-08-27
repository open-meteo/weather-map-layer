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
}

export const defaultFileReaderConfig: Required<Omit<FileReaderConfig, 'cache'>> = {
	useSAB: typeof SharedArrayBuffer !== 'undefined',
	retries: 2,
	eTagValidation: false
};

/**
 * Convenience class for reading from OM-files implementing some utility conversions during reading.
 */
export class WeatherMapLayerFileReader {
	readonly cache: BlockCache;
	readonly config: Required<Omit<FileReaderConfig, 'cache'>>;
	private readonly allDerivationRules: VariableDerivationRule[];
	/** Memoizes one backend per URL, so repeat reads skip the HEAD request. */
	private readonly backendPool: OmHttpBackendPool;

	constructor(config: FileReaderConfig = {}) {
		this.config = {
			...defaultFileReaderConfig,
			...config
		};

		// TODO: This could be a combination of user-defined and default derivation rules
		this.allDerivationRules = DEFAULT_DERIVATION_RULES;

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

	/** Find the first derivation rule that matches the given variable name. */
	private findDerivationRule(variable: string): VariableDerivationRule | undefined {
		return this.allDerivationRules.find((rule) => {
			if (typeof rule.pattern === 'string') {
				return variable.includes(rule.pattern);
			} else {
				return rule.pattern.test(variable);
			}
		});
	}

	/** Read variable data using a derivation rule. */
	private async readWithDerivationRule(
		reader: OmFileReader,
		variable: string,
		rule: VariableDerivationRule,
		ranges: DimensionRange[] | null,
		signal?: AbortSignal
	): Promise<Data> {
		const [primaryVar, secondaryVar] = rule.getSourceVars(variable);

		// Get readers for source variables
		let primaryReader: OmFileReader | null = null;
		let secondaryReader: OmFileReader | null = null;
		try {
			primaryReader = await reader.getChildByName(primaryVar);
			if (!primaryReader) {
				throw new Error(`Primary variable ${primaryVar} not found`);
			}

			secondaryReader = await reader.getChildByName(secondaryVar);
			if (!secondaryReader) {
				throw new Error(`Secondary variable ${secondaryVar} not found`);
			}

			// Read data
			const dimensions = primaryReader.getDimensions();
			const readRanges = this.getRanges(ranges, dimensions);
			const readOptions: OmFileReadOptions<OmDataType.FloatArray> = {
				type: OmDataType.FloatArray,
				ranges: readRanges,
				intoSAB: this.config.useSAB,
				signal
			};

			const primaryPromise = primaryReader.read(readOptions);
			const secondaryPromise = secondaryReader.read(readOptions);
			const [primaryData, secondaryData] = await Promise.all([primaryPromise, secondaryPromise]);

			// Process using the rule
			const data = rule.process(primaryData, secondaryData);

			// Every derivation rule defines its quantization scale factor so the
			// half-quantum threshold offset is always available. `'primary'` inherits
			// the primary source variable's stored scale factor — exact when `values`
			// is the primary passed through unchanged (speed/direction, wave), and a
			// good proxy for derived magnitudes (wind speed from u/v).
			data.scaleFactor =
				rule.scaleFactor === 'primary' ? primaryReader.scaleFactor() : rule.scaleFactor;

			return data;
		} finally {
			// Child readers hold their own wasm allocations; disposing the scoped
			// root reader does not free them.
			primaryReader?.dispose();
			secondaryReader?.dispose();
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
			const derivationRule = this.findDerivationRule(variable);

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
			const derivationRule = this.findDerivationRule(variable);
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
 * Rule for deriving values and directions from one or two source variables.
 */
interface VariableDerivationRule {
	/** Pattern to match variable names (string or RegExp) */
	pattern: string | RegExp;

	/** Derive two variables from the requested variable. */
	getSourceVars: (variable: string) => [string, string];

	/**
	 * Quantization scale factor of the derived `values`, so a half-quantum
	 * threshold offset can be applied. `'primary'` uses the primary source
	 * variable's stored scale factor; a number sets a fixed factor.
	 */
	scaleFactor: number | 'primary';

	/**
	 * Process the raw data from source variables into values and directions.
	 * @param primary - Data from the primary source variable
	 * @param secondary - Data from the secondary source variable
	 * @returns Data object with values and optional directions
	 */
	process: (primary: Float32Array, secondary: Float32Array) => Data;
}

/**
 * Default derivation rules for common meteorological variables.
 */
const DEFAULT_DERIVATION_RULES: VariableDerivationRule[] = [
	// UV wind components -> speed and direction
	{
		pattern: /_[uv]_(component|current)/,
		// Derived magnitude; the u-component's stored scale factor is a good proxy
		// for the speed's quantization step.
		scaleFactor: 'primary',
		getSourceVars: (variable: string) => {
			let postfix = '';
			const match = variable.match(/_[uv]_(?<postfix>component|current)/);
			if (match?.groups) {
				postfix = match.groups.postfix;
			}
			return [
				variable.replace(`_v_${postfix}`, `_u_${postfix}`),
				variable.replace(`_u_${postfix}`, `_v_${postfix}`)
			];
		},
		process: (u: Float32Array, v: Float32Array) => {
			const BufferConstructor = u.buffer.constructor as typeof ArrayBuffer;
			const values = new Float32Array(new BufferConstructor(u.byteLength));
			const directions = new Float32Array(new BufferConstructor(u.byteLength));

			for (let i = 0; i < u.length; i++) {
				values[i] = Math.sqrt(u[i] * u[i] + v[i] * v[i]);
				directions[i] = (radiansToDegrees(fastAtan2(u[i], v[i])) + 180) % 360;
			}

			return { values, directions };
		}
	},

	// Speed/Direction pairs (already stored separately)
	{
		pattern: /_(?:speed|direction)_/,
		scaleFactor: 'primary',
		getSourceVars: (variable: string) => [
			variable.includes('_speed_') ? variable : variable.replace('_direction_', '_speed_'),
			variable.includes('_direction_') ? variable : variable.replace('_speed_', '_direction_')
		],
		process: (speed: Float32Array, direction: Float32Array) => ({
			values: speed,
			directions: direction
		})
	},

	// Wave height and direction
	{
		pattern: /wave_(?:height|direction)/,
		scaleFactor: 'primary',
		getSourceVars: (variable: string) => [
			variable.replace('wave_direction', 'wave_height'),
			variable.replace('wave_height', 'wave_direction')
		],
		process: (height: Float32Array, direction: Float32Array) => ({
			values: height,
			directions: direction
		})
	}
];
