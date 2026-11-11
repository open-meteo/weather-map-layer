import {
	BlockCache,
	LruBlockCache,
	OmDataType,
	OmFileReadOptions,
	type OmFileReader,
	OmHttpBackendPool
} from '@openmeteo/file-reader';

import { wktToGridData } from './utils/wkt';

import {
	type DerivationContext,
	type VariableDerivationRule,
	defaultDerivationRules,
	patternMatches,
	variableIsAccumulated
} from './derivation-rules';

import type { Data, DimensionRange, Domain, GridData } from './types';

/** Grid definitions are memoized per file URL; every timestep is a new URL. */
const GRID_DATA_CACHE_MAX = 32;

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
	 * Copied once, when the reader is built (the protocol builds its shared
	 * reader on the first request): like the other `fileReaderConfig` fields,
	 * later changes are ignored.
	 *
	 * @default defaultDerivationRules
	 */
	derivationRules?: VariableDerivationRule[];
}

/** What the caller knows about a file beyond its URL, for the derivation rules. */
export interface ReadContext {
	/**
	 * Length of the file's time step in hours: the reader divides the
	 * precipitation family's per-step sums by it, and rules that ask for it
	 * (`usesDeltaTime`) get it. The om protocol passes on the
	 * `delta_time_hours` parameter of the om URL, which the host application
	 * sets from the run's valid times; a direct call has to pass it for such
	 * a variable (`variableUsesDeltaTime`), or the read is rejected.
	 */
	deltaTimeHours?: number;

	/**
	 * The domain the file belongs to, for rules that depend on how a model
	 * stores a quantity (`wave_directions_towards`). The om protocol passes
	 * the domain it resolved from the URL.
	 */
	domain?: Domain;
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
	/** Grid definitions by file URL, see `readGridData`. */
	private readonly gridDataCache = new Map<string, Promise<GridData>>();

	constructor(config: FileReaderConfig = {}) {
		this.config = {
			...defaultFileReaderConfig,
			...config,
			// A copy: the list is fixed for the reader's lifetime, so a caller
			// editing its array afterwards cannot change what later reads derive
			// while earlier reads were made with the old rules.
			derivationRules: [...(config.derivationRules ?? defaultDerivationRules)]
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
	 * asked, so a file is not listed for names no rule is interested in. A
	 * read through a rule needing the time step is rejected when the caller
	 * passed none; a prefetch only needs the source names and goes ahead.
	 */
	private async resolveDerivation(
		reader: OmFileReader,
		variable: string,
		read: ReadContext,
		prefetch = false
	): Promise<ResolvedDerivation | undefined> {
		const candidates = this.config.derivationRules.filter((rule) =>
			patternMatches(rule.pattern, variable)
		);
		if (candidates.length === 0) return undefined;

		const stored = await listRootVariables(reader);
		const context: DerivationContext = {
			variable,
			stored,
			deltaTimeHours: read.deltaTimeHours,
			domain: read.domain
		};

		for (const rule of candidates) {
			const sourceVars = rule.getSourceVars(context);
			if (sourceVars === null) continue;
			if (sourceVars.length === 0) {
				throw new Error(`Derivation rule for ${variable} returned no source variables`);
			}
			if (rule.usesDeltaTime && context.deltaTimeHours === undefined && !prefetch) {
				throw new Error(
					`${variable} is derived from the length of the file's time step, which the caller did not pass (deltaTimeHours)`
				);
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

			// A rule may build its output with plain typed-array methods. Moving it
			// into shared memory once per read keeps the grid zero-copy for the tile
			// workers, which would otherwise clone it per tile.
			if (this.config.useSAB) {
				data.values = intoSharedBuffer(data.values);
				data.directions = intoSharedBuffer(data.directions);
			}

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
	 * @param read What is known about the file beyond its URL (the time step)
	 * @returns Promise resolving to data object containing values and optional directions
	 */
	async readVariable(
		omUrl: string,
		variable: string,
		ranges: DimensionRange[] | null = null,
		signal?: AbortSignal,
		read: ReadContext = {}
	): Promise<Data> {
		const accumulated = variableIsAccumulated(variable);
		if (accumulated && read.deltaTimeHours === undefined) {
			throw new Error(
				`${variable} is shown per hour, which needs the length of the file's time step, but the caller did not pass it (deltaTimeHours)`
			);
		}
		const data = await this.withReader(omUrl, async (reader) => {
			const derivation = await this.resolveDerivation(reader, variable, read);

			if (derivation) {
				return this.readWithDerivationRule(reader, derivation, ranges, signal);
			} else {
				return this.readSimpleVariable(reader, variable, ranges, signal);
			}
		});
		return accumulated ? perHour(data, read.deltaTimeHours!) : data;
	}

	/**
	 * Read the grid definition of the given .om file from the dimensions of
	 * `variable` (or of its primary source variable when it is derived) and the
	 * file's `crs_wkt` attribute. Every tile request of a file resolves its grid,
	 * so the result is memoized per URL; failures are not kept.
	 */
	async readGridData(omUrl: string, variable: string): Promise<GridData> {
		const cached = this.gridDataCache.get(omUrl);
		if (cached) {
			return cached;
		}

		const gridData = this.withReader(omUrl, async (reader) => {
			const dimensions = await this.readVariableDimensions(reader, variable);
			const crsReader = await reader.getChildByName('crs_wkt');
			if (!crsReader) {
				throw new Error(`No crs_wkt attribute in ${omUrl}`);
			}
			try {
				const wkt = crsReader.readScalar<string>(OmDataType.String);
				if (!wkt) {
					throw new Error(`Empty crs_wkt attribute in ${omUrl}`);
				}
				const [ny, nx] = dimensions;
				return wktToGridData(wkt, nx, ny);
			} finally {
				crsReader.dispose();
			}
		});
		gridData.catch(() => this.gridDataCache.delete(omUrl));

		this.gridDataCache.set(omUrl, gridData);
		if (this.gridDataCache.size > GRID_DATA_CACHE_MAX) {
			this.gridDataCache.delete(this.gridDataCache.keys().next().value!);
		}
		return gridData;
	}

	/** Dimensions ([ny, nx]) of a variable, or of its primary source when derived. */
	private async readVariableDimensions(reader: OmFileReader, variable: string): Promise<number[]> {
		// The first rule claiming the variable for this file names what is read
		const stored = await listRootVariables(reader);
		const context: DerivationContext = { variable, stored };
		let name = variable;
		for (const rule of this.config.derivationRules) {
			if (!patternMatches(rule.pattern, variable)) continue;
			const sourceVars = rule.getSourceVars(context);
			if (sourceVars?.length) {
				name = sourceVars[0];
				break;
			}
		}
		const variableReader = await reader.getChildByName(name);
		if (!variableReader) {
			throw new Error(`Variable: ${name} not found`);
		}
		try {
			const dimensions = variableReader.getDimensions();
			if (dimensions.length !== 2) {
				throw new Error(`Variable ${name} is not a 2D grid: dimensions ${dimensions.join('x')}`);
			}
			return dimensions;
		} finally {
			variableReader.dispose();
		}
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
			const derivation = await this.resolveDerivation(reader, variable, {}, true);
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
 * A per-step sum as an hourly rate. In place: every read yields fresh arrays.
 * The quantum shrinks with the division, so the scale factor grows by it.
 */
const perHour = (data: Data, deltaTimeHours: number): Data => {
	const values = data.values;
	if (values && deltaTimeHours !== 1) {
		for (let i = 0; i < values.length; i++) values[i] /= deltaTimeHours;
	}
	if (data.scaleFactor !== undefined) data.scaleFactor *= deltaTimeHours;
	return data;
};

/** `array` in a SharedArrayBuffer: itself when it already is, otherwise a copy. */
const intoSharedBuffer = (array: Float32Array | undefined): Float32Array | undefined => {
	if (!array || array.buffer instanceof SharedArrayBuffer) return array;
	const shared = new Float32Array(new SharedArrayBuffer(array.byteLength));
	shared.set(array);
	return shared;
};
