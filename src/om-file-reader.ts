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
	/** Whether to use SharedArrayBuffer for data reading. @default false */
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
	useSAB: false,
	retries: 2,
	eTagValidation: false
};

/**
 * Convenience class for reading from OM-files implementing some utility conversions during reading.
 */
export class WeatherMapLayerFileReader {
	/**
	 * Open readers keyed by file URL, in LRU order (oldest first). Keeping one
	 * reader per URL (instead of one shared, re-pointed reader) makes reads
	 * atomic with respect to the file they target: concurrent reads for
	 * different files — e.g. a prefetch of the next timestep racing a tile data
	 * load — can no longer interleave `setToOmFile` and `readVariable` and read
	 * from the wrong file. It also avoids re-parsing the file trailer every time
	 * the user switches back and forth between recently used files.
	 */
	private readers = new Map<string, OpenReader>();
	/** URL targeted by the legacy `setToOmFile` / url-less read methods. */
	private currentUrl?: string;
	private static readonly MAX_OPEN_READERS = 6;

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
	 * Get (or open) the reader entry for a file URL, refreshing its LRU position
	 * and taking a reference on it. Every acquire() MUST be paired with a
	 * release() (try/finally) once the operation using the reader has finished.
	 * Eviction only marks an entry; the underlying reader is disposed when the
	 * last in-flight operation releases it — never under an active read.
	 */
	private acquire(omUrl: string): OpenReader {
		let entry = this.readers.get(omUrl);
		if (entry) {
			// Re-insert to mark as most recently used
			this.readers.delete(omUrl);
			this.readers.set(omUrl, entry);
		} else {
			const backend = new OmHttpBackend({
				url: omUrl,
				eTagValidation: this.config.eTagValidation,
				retries: this.config.retries
			});
			const newEntry: OpenReader = {
				promise: backend.asCachedReader(this.cache),
				refs: 0,
				evicted: false
			};
			entry = newEntry;

			// Don't keep failed opens around — the next request should retry.
			newEntry.promise.catch(() => {
				if (this.readers.get(omUrl) === newEntry) {
					this.readers.delete(omUrl);
				}
			});

			this.readers.set(omUrl, entry);

			// Evict least recently used readers beyond the cap. Entries still in
			// use are disposed by their release() instead.
			while (this.readers.size > WeatherMapLayerFileReader.MAX_OPEN_READERS) {
				const oldest = this.readers.entries().next().value;
				if (!oldest) break;
				const [oldestUrl, oldestEntry] = oldest;
				this.readers.delete(oldestUrl);
				oldestEntry.evicted = true;
				if (oldestEntry.refs === 0) {
					disposeWhenReady(oldestEntry);
				}
			}
		}

		entry.refs++;
		return entry;
	}

	private release(entry: OpenReader): void {
		entry.refs--;
		if (entry.evicted && entry.refs <= 0) {
			disposeWhenReady(entry);
		}
	}

	/**
	 * Points the url-less legacy methods (`readVariable`, `prefetchVariable`) at
	 * a file and warms its reader. Prefer the `...FromUrl` variants, which are
	 * safe against concurrent calls for different files.
	 */
	async setToOmFile(omUrl: string): Promise<void> {
		this.currentUrl = omUrl;
		const entry = this.acquire(omUrl);
		try {
			await entry.promise;
		} finally {
			this.release(entry);
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
		fileReader: OmFileReader,
		variable: string,
		rule: VariableDerivationRule,
		ranges: DimensionRange[] | null,
		signal?: AbortSignal
	): Promise<Data> {
		const [primaryVar, secondaryVar] = rule.getSourceVars(variable);

		// Get readers for source variables
		const primaryReader = await fileReader.getChildByName(primaryVar);
		if (!primaryReader) {
			throw new Error(`Primary variable ${primaryVar} not found`);
		}

		const secondaryReader = await fileReader.getChildByName(secondaryVar);
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
		return rule.process(primaryData, secondaryData);
	}

	/**
	 * Read a single variable directly (no derivation).
	 */
	private async readSimpleVariable(
		fileReader: OmFileReader,
		variable: string,
		ranges: DimensionRange[] | null,
		signal?: AbortSignal
	): Promise<Data> {
		const variableReader = await fileReader.getChildByName(variable);
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

		return { values, directions: undefined };
	}

	/**
	 * Read a specific variable from the file. Implements on the fly conversion for
	 * some variables, e.g. uv components are converted to speed and direction.
	 *
	 * @param variable The variable to read.
	 * @param ranges The ranges to read. If null, all dimensions are read.
	 * @param signal Optional AbortSignal
	 * @returns Promise resolving to data object containing values and optional directions
	 */
	async readVariable(
		variable: string,
		ranges: DimensionRange[] | null = null,
		signal?: AbortSignal
	): Promise<Data> {
		if (!this.currentUrl) {
			throw new Error('Reader not initialized. Call setToOmFile() first.');
		}
		return this.readVariableFromUrl(this.currentUrl, variable, ranges, signal);
	}

	/**
	 * Like `readVariable`, but scoped to an explicit file URL — safe against
	 * concurrent reads targeting other files on the same reader instance.
	 */
	async readVariableFromUrl(
		omUrl: string,
		variable: string,
		ranges: DimensionRange[] | null = null,
		signal?: AbortSignal
	): Promise<Data> {
		const entry = this.acquire(omUrl);
		try {
			const fileReader = await entry.promise;
			const derivationRule = this.findDerivationRule(variable);

			if (derivationRule) {
				return await this.readWithDerivationRule(
					fileReader,
					variable,
					derivationRule,
					ranges,
					signal
				);
			} else {
				return await this.readSimpleVariable(fileReader, variable, ranges, signal);
			}
		} finally {
			this.release(entry);
		}
	}

	/**
	 * Prefetch data for a specific variable and range into the local cache.
	 * This is useful for warming up the cache for anticipated map movements.
	 */
	async prefetchVariable(
		variable: string,
		ranges: DimensionRange[] | null = null,
		signal?: AbortSignal
	): Promise<void> {
		// Capture the target synchronously so a later setToOmFile cannot
		// redirect this prefetch to a different file.
		const omUrl = this.currentUrl;
		if (!omUrl) return;
		return this.prefetchVariableFromUrl(omUrl, variable, ranges, signal);
	}

	/** Like `prefetchVariable`, but scoped to an explicit file URL. */
	async prefetchVariableFromUrl(
		omUrl: string,
		variable: string,
		ranges: DimensionRange[] | null = null,
		signal?: AbortSignal
	): Promise<void> {
		const entry = this.acquire(omUrl);
		try {
			const fileReader = await entry.promise;

			const derivationRule = this.findDerivationRule(variable);
			const varsToPrefetch = derivationRule ? derivationRule.getSourceVars(variable) : [variable];

			await Promise.all(
				varsToPrefetch.map(async (v) => {
					const variableReader = await fileReader.getChildByName(v);
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
		} finally {
			this.release(entry);
		}
	}

	dispose() {
		for (const entry of this.readers.values()) {
			entry.evicted = true;
			if (entry.refs === 0) {
				disposeWhenReady(entry);
			}
		}
		this.readers.clear();
		this.currentUrl = undefined;
	}
}

/**
 * A reader held in the per-URL LRU. `refs` counts in-flight operations using
 * it; when an entry is evicted (or the whole instance disposed) the underlying
 * OmFileReader is only disposed once the last operation has released it, so an
 * eviction can never pull the reader out from under an active read/prefetch.
 */
interface OpenReader {
	promise: Promise<OmFileReader>;
	refs: number;
	evicted: boolean;
}

const disposeWhenReady = (entry: OpenReader): void => {
	entry.promise.then((reader) => reader.dispose()).catch(() => {});
};

/**
 * Rule for deriving values and directions from one or two source variables.
 */
interface VariableDerivationRule {
	/** Pattern to match variable names (string or RegExp) */
	pattern: string | RegExp;

	/** Derive two variables from the requested variable. */
	getSourceVars: (variable: string) => [string, string];

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
