import {
	BlockCache,
	LruBlockCache,
	OmDataType,
	OmFileReadOptions,
	type OmFileReader,
	OmHttpBackendPool
} from '@openmeteo/file-reader';

import {
	type ResolvedDerivation,
	type VariableDerivationRule,
	applyDerivation,
	defaultDerivationRules,
	patternMatches,
	resolveDerivation,
	variableIsAccumulated
} from './derivation-rules';
import { GribFileReader, isGribIndexUrl } from './grib/grib-file-reader';

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
}

export const defaultFileReaderConfig: Required<
	Omit<FileReaderConfig, 'cache' | 'derivationRules'>
> = {
	useSAB: typeof SharedArrayBuffer !== 'undefined',
	retries: 2,
	eTagValidation: false
};

/**
 * Convenience class for reading from OM-files implementing some utility
 * conversions during reading. A URL naming a GRIB index file (`.idx`) is read
 * from the indexed GRIB2 file instead, through the same derivation rules.
 */
export class WeatherMapLayerFileReader {
	readonly cache: BlockCache;
	readonly config: Required<Omit<FileReaderConfig, 'cache'>>;
	/** Memoizes one backend per URL, so repeat reads skip the HEAD request. */
	private readonly backendPool: OmHttpBackendPool;
	/** Reads the `.idx` URLs; holds its own inventory and field caches. */
	readonly gribReader: GribFileReader;

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

		this.gribReader = new GribFileReader({
			useSAB: this.config.useSAB,
			retries: this.config.retries,
			derivationRules: this.config.derivationRules
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
	private async resolveFileDerivation(
		reader: OmFileReader,
		variable: string,
		read: ReadContext,
		prefetch = false
	): Promise<ResolvedDerivation | undefined> {
		const rules = this.config.derivationRules;
		if (!rules.some((rule) => patternMatches(rule.pattern, variable))) return undefined;

		const stored = await listRootVariables(reader);
		return resolveDerivation(rules, variable, stored, read.deltaTimeHours, prefetch);
	}

	/** Read variable data using a derivation rule. */
	private async readWithDerivationRule(
		reader: OmFileReader,
		derivation: ResolvedDerivation,
		ranges: DimensionRange[] | null,
		signal?: AbortSignal
	): Promise<Data> {
		const { sourceVars } = derivation;
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

			return applyDerivation(
				derivation,
				sourceData,
				sourceReaders[0]!.scaleFactor(),
				this.config.useSAB
			);
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
	 * @param omUrl The .om file URL to read from, or the `.idx` URL of an indexed GRIB2 file.
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
		if (isGribIndexUrl(omUrl)) {
			// GRIB stores precipitation as a rate, so the per-step sums the
			// `.om` files hold, and the time step dividing them, do not apply
			return this.gribReader.readVariable(omUrl, variable, ranges, signal, read.deltaTimeHours);
		}

		const accumulated = variableIsAccumulated(variable);
		if (accumulated && read.deltaTimeHours === undefined) {
			throw new Error(
				`${variable} is shown per hour, which needs the length of the file's time step, but the caller did not pass it (deltaTimeHours)`
			);
		}
		const data = await this.withReader(omUrl, async (reader) => {
			const derivation = await this.resolveFileDerivation(reader, variable, read);

			if (derivation) {
				return this.readWithDerivationRule(reader, derivation, ranges, signal);
			} else {
				return this.readSimpleVariable(reader, variable, ranges, signal);
			}
		});
		return accumulated ? perHour(data, read.deltaTimeHours!) : data;
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
		if (isGribIndexUrl(omUrl)) {
			// A GRIB message is fetched whole, so the ranges play no part
			return this.gribReader.prefetchVariable(omUrl, variable, signal);
		}
		await this.withReader(omUrl, async (reader) => {
			const derivation = await this.resolveFileDerivation(reader, variable, {}, true);
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
		if (isGribIndexUrl(omUrl)) return this.gribReader.warmIndex(omUrl);
		await this.withReader(omUrl, async () => {});
	}

	/** Drop all memoized backends and GRIB inventories, forcing fresh metadata requests. */
	clearBackends(): void {
		this.backendPool.clear();
		this.gribReader.clear();
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
