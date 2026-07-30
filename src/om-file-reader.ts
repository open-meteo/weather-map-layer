import {
	BlockCache,
	LruBlockCache,
	OmDataType,
	OmFileReadOptions,
	type OmFileReader,
	OmHttpBackend
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
	 * Maximum number of simultaneously open per-URL file readers. Least
	 * recently used readers beyond this cap are disposed (deferred until
	 * their in-flight reads finish). Needs to cover every file that can be
	 * read concurrently: displayed variables plus prefetched neighbour
	 * timesteps. @default 12
	 */
	maxOpenFiles?: number;
}

export const defaultFileReaderConfig: Required<Omit<FileReaderConfig, 'cache'>> = {
	useSAB: typeof SharedArrayBuffer !== 'undefined',
	retries: 2,
	eTagValidation: false,
	maxOpenFiles: 12
};

/** One memoized reader per .om file URL. */
interface ReaderEntry {
	promise: Promise<OmFileReader>;
	/** Number of in-flight read/prefetch operations using this reader. */
	activeOps: number;
	/** Evicted from the LRU; dispose once the last active operation finishes. */
	evicted: boolean;
}

/**
 * Convenience class for reading from OM-files implementing some utility conversions during reading.
 */
export class WeatherMapLayerFileReader {
	/** Memoized per-URL readers in LRU order (oldest first). */
	private readers = new Map<string, ReaderEntry>();
	/** URL targeted by the legacy `setToOmFile`/`readVariable` API. */
	private currentUrl?: string;
	readonly cache: BlockCache;
	readonly config: Required<Omit<FileReaderConfig, 'cache'>>;
	private readonly allDerivationRules: VariableDerivationRule[];

	constructor(config: FileReaderConfig = {}) {
		this.config = {
			...defaultFileReaderConfig,
			...config
		};

		// TODO: This could be a combination of user-defined and default derivation rules
		this.allDerivationRules = DEFAULT_DERIVATION_RULES;

		// Use the injected cache, or fall back to an in-memory LRU cache
		this.cache = config.cache ?? new LruBlockCache(64 * 1024, 128);
	}

	/**
	 * Point the legacy single-file API at `omUrl`. Readers for other URLs stay
	 * open (bounded by `maxOpenFiles`), so concurrent reads of multiple files
	 * are safe.
	 */
	async setToOmFile(omUrl: string): Promise<void> {
		this.currentUrl = omUrl;
		await this.acquireReader(omUrl);
	}

	/** Get (or create) the memoized reader for a URL and mark it recently used. */
	private acquireReader(omUrl: string): Promise<OmFileReader> {
		const existing = this.readers.get(omUrl);
		if (existing) {
			// Re-insert to move to the most recently used position
			this.readers.delete(omUrl);
			this.readers.set(omUrl, existing);
			return existing.promise;
		}

		const s3Backend = new OmHttpBackend({
			url: omUrl,
			eTagValidation: this.config.eTagValidation,
			retries: this.config.retries
		});
		const entry: ReaderEntry = {
			promise: s3Backend.asCachedReader(this.cache),
			activeOps: 0,
			evicted: false
		};
		this.readers.set(omUrl, entry);
		// Failed opens must not stay memoized, otherwise retries are impossible
		entry.promise.catch(() => {
			if (this.readers.get(omUrl) === entry) this.readers.delete(omUrl);
		});

		while (this.readers.size > this.config.maxOpenFiles) {
			const oldest = this.readers.entries().next().value;
			if (!oldest) break;
			this.readers.delete(oldest[0]);
			this.markEvicted(oldest[1]);
		}

		return entry.promise;
	}

	private markEvicted(entry: ReaderEntry): void {
		entry.evicted = true;
		if (entry.activeOps === 0) {
			entry.promise.then((reader) => reader.dispose()).catch(() => {});
		}
	}

	/** Run `fn` with the reader for `omUrl`, deferring disposal while it runs. */
	private async withReader<T>(omUrl: string, fn: (reader: OmFileReader) => Promise<T>): Promise<T> {
		const promise = this.acquireReader(omUrl);
		const entry = this.readers.get(omUrl);
		if (entry) entry.activeOps++;
		try {
			return await fn(await promise);
		} finally {
			if (entry) {
				entry.activeOps--;
				if (entry.evicted && entry.activeOps === 0) {
					entry.promise.then((reader) => reader.dispose()).catch(() => {});
				}
			}
		}
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
		const primaryReader = await reader.getChildByName(primaryVar);
		if (!primaryReader) {
			throw new Error(`Primary variable ${primaryVar} not found`);
		}

		const secondaryReader = await reader.getChildByName(secondaryVar);
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

		const dimensions = variableReader.getDimensions();
		const readRanges = this.getRanges(ranges, dimensions);

		const values = (await variableReader.read({
			type: OmDataType.FloatArray,
			ranges: readRanges,
			intoSAB: this.config.useSAB,
			signal
		})) as Float32Array;

		return { values, directions: undefined, scaleFactor: variableReader.scaleFactor() };
	}

	/**
	 * Read a specific variable from the given .om file. Implements on the fly
	 * conversion for some variables, e.g. uv components are converted to speed
	 * and direction. Safe to call concurrently for different files.
	 *
	 * @param omUrl The .om file URL to read from.
	 * @param variable The variable to read.
	 * @param ranges The ranges to read. If null, all dimensions are read.
	 * @param signal Optional AbortSignal
	 * @returns Promise resolving to data object containing values and optional directions
	 */
	async readVariableFromFile(
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
	 * Read a specific variable from the current file (see `setToOmFile`).
	 * Prefer `readVariableFromFile` when multiple files are read concurrently.
	 */
	async readVariable(
		variable: string,
		ranges: DimensionRange[] | null = null,
		signal?: AbortSignal
	): Promise<Data> {
		if (!this.currentUrl) {
			throw new Error('Reader not initialized. Call setToOmFile() first.');
		}
		return this.readVariableFromFile(this.currentUrl, variable, ranges, signal);
	}

	/**
	 * Prefetch data for a specific variable and range of the given .om file
	 * into the local cache. This is useful for warming up the cache for
	 * anticipated map movements or timestep changes.
	 */
	async prefetchVariableFromFile(
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

					const dimensions = variableReader.getDimensions();
					const readRanges = this.getRanges(ranges, dimensions);

					// readPrefetch warms up the backend cache by requesting the necessary
					// data blocks without decoding them or copying them to a TypedArray.
					await variableReader.readPrefetch({
						prefetchConcurrency: 1000, // concurrency limiting on requests is executed via the BlockCache
						ranges: readRanges,
						signal
					});
				})
			);
		});
	}

	/**
	 * Prefetch a variable from the current file (see `setToOmFile`).
	 * Prefer `prefetchVariableFromFile` when multiple files are involved.
	 */
	async prefetchVariable(
		variable: string,
		ranges: DimensionRange[] | null = null,
		signal?: AbortSignal
	): Promise<void> {
		if (!this.currentUrl) return;
		return this.prefetchVariableFromFile(this.currentUrl, variable, ranges, signal);
	}

	dispose() {
		for (const entry of this.readers.values()) {
			this.markEvicted(entry);
		}
		this.readers.clear();
		this.currentUrl = undefined;
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
