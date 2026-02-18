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
 * Configuration options for the MapboxLayerFileReader.
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
export class MapboxLayerFileReader {
	private reader?: OmFileReader;
	private cache: BlockCache;
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

	async setToOmFile(omUrl: string): Promise<void> {
		this.dispose();
		const s3Backend = new OmHttpBackend({
			url: omUrl,
			eTagValidation: this.config.eTagValidation,
			retries: this.config.retries
		});
		this.reader = await s3Backend.asCachedReader(this.cache);
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
		variable: string,
		rule: VariableDerivationRule,
		ranges: DimensionRange[] | null,
		signal?: AbortSignal
	): Promise<Data> {
		if (!this.reader) {
			throw new Error('Reader not initialized. Call setToOmFile() first.');
		}

		const [primaryVar, secondaryVar] = rule.getSourceVars(variable);

		// Get readers for source variables
		const primaryReader = await this.reader.getChildByName(primaryVar);
		if (!primaryReader) {
			throw new Error(`Primary variable ${primaryVar} not found`);
		}

		const secondaryReader = await this.reader.getChildByName(secondaryVar);
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
		variable: string,
		ranges: DimensionRange[] | null,
		signal?: AbortSignal
	): Promise<Data> {
		if (!this.reader) {
			throw new Error('Reader not initialized. Call setToOmFile() first.');
		}

		const variableReader = await this.reader.getChildByName(variable);
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
		const derivationRule = this.findDerivationRule(variable);

		if (derivationRule) {
			return this.readWithDerivationRule(variable, derivationRule, ranges, signal);
		} else {
			return this.readSimpleVariable(variable, ranges, signal);
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
		if (!this.reader) return;

		const derivationRule = this.findDerivationRule(variable);
		const varsToPrefetch = derivationRule ? derivationRule.getSourceVars(variable) : [variable];

		await Promise.all(
			varsToPrefetch.map(async (v) => {
				const variableReader = await this.reader!.getChildByName(v);
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
	}

	dispose() {
		if (this.reader) {
			this.reader.dispose();
		}

		delete this.reader;
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
