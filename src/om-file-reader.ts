import { OmDataType, type OmFileReader, OmHttpBackend } from '@openmeteo/file-reader';

import { fastAtan2, radiansToDegrees } from './utils/math';

import type { Data } from './om-protocol';
import { pad } from './utils';

import type { DimensionRange } from './types';

/**
 * Configuration options for the OMapsFileReader.
 */
interface FileReaderConfig {
	/** Whether to use SharedArrayBuffer for data reading. @default false */
	useSAB?: boolean;
	/** Maximum number of cached HTTP backends. @default 50 */
	maxCachedFiles?: number;
	/** Number of retry attempts for failed requests. @default 2 */
	retries?: number;
	/** Whether to validate ETags for cache coherency. @default false */
	eTagValidation?: boolean;
}

/**
 * Convenience class for reading from OM-files implementing some utility conversions during reading.
 *
 * Caches the backend of recently accessed files.
 */
export class OMapsFileReader {
	private static readonly s3BackendCache = new Map<string, OmHttpBackend>();

	private reader?: OmFileReader;
	private readonly config: Required<FileReaderConfig>;

	constructor(config: FileReaderConfig = {}) {
		this.config = {
			useSAB: false,
			maxCachedFiles: 50,
			retries: 2,
			eTagValidation: false,
			...config
		};
	}

	async setToOmFile(omUrl: string): Promise<void> {
		this.dispose();

		let s3Backend = OMapsFileReader.s3BackendCache.get(omUrl);
		if (!s3Backend) {
			s3Backend = new OmHttpBackend({
				url: omUrl,
				eTagValidation: this.config.eTagValidation,
				retries: this.config.retries
			});
			this.setCachedBackend(omUrl, s3Backend);
		}
		this.reader = await s3Backend.asCachedReader();
	}

	private setCachedBackend(url: string, backend: OmHttpBackend): void {
		// Implement LRU-like cache management
		if (OMapsFileReader.s3BackendCache.size >= this.config.maxCachedFiles) {
			const firstKey = OMapsFileReader.s3BackendCache.keys().next().value;
			if (firstKey) {
				OMapsFileReader.s3BackendCache.delete(firstKey);
			}
		}

		OMapsFileReader.s3BackendCache.set(url, backend);
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
	 * Read a specific variable from the file. Implements on the fly conversion for
	 * some variables, e.g. uv components are converted to speed and direction.
	 *
	 * @param variable The variable to read.
	 * @param ranges The ranges to read. If null, all dimensions are read.
	 * @returns Promise resolving to data object containing values and optional directions
	 */
	async readVariable(variable: string, ranges: DimensionRange[] | null = null): Promise<Data> {
		if (!this.reader) {
			throw new Error('Reader not initialized. Call init() first.');
		}

		let values, directions: Float32Array | undefined;
		if (variable.includes('_u_component')) {
			// combine uv components, and calculate directions
			const variableReaderU = await this.reader.getChildByName(variable);
			const variableReaderV = await this.reader.getChildByName(
				variable.replace('_u_component', '_v_component')
			);

			if (!variableReaderU || !variableReaderV) {
				throw new Error(`Variable ${variable} not found`);
			}

			const dimensions = variableReaderU.getDimensions();
			const readRanges = this.getRanges(ranges, dimensions);

			const valuesUPromise = variableReaderU.read({
				type: OmDataType.FloatArray,
				ranges: readRanges,
				intoSAB: this.config.useSAB
			});
			const valuesVPromise = variableReaderV.read({
				type: OmDataType.FloatArray,
				ranges: readRanges,
				intoSAB: this.config.useSAB
			});

			const [valuesU, valuesV]: [Float32Array, Float32Array] = (await Promise.all([
				valuesUPromise,
				valuesVPromise
			])) as [Float32Array, Float32Array];

			const BufferConstructor = valuesU.buffer.constructor as typeof ArrayBuffer;
			values = new Float32Array(new BufferConstructor(valuesU.byteLength));
			directions = new Float32Array(new BufferConstructor(valuesU.byteLength));

			for (let i = 0; i < valuesU.length; ++i) {
				const u = valuesU[i];
				const v = valuesV[i];
				values[i] = Math.sqrt(u * u + v * v);
				directions[i] = (radiansToDegrees(fastAtan2(u, v)) + 180) % 360;
			}
		} else {
			const variableReader = await this.reader.getChildByName(variable);

			if (!variableReader) {
				throw new Error(`Variable ${variable} not found`);
			}

			const dimensions = variableReader.getDimensions();
			const readRanges = this.getRanges(ranges, dimensions);

			values = await variableReader?.read({
				type: OmDataType.FloatArray,
				ranges: readRanges,
				intoSAB: this.config.useSAB
			});
		}

		if (variable.includes('_speed_')) {
			// also get the direction for speed values
			const variableReader = await this.reader.getChildByName(
				variable.replace('_speed_', '_direction_')
			);

			if (!variableReader) {
				throw new Error(`Variable ${variable.replace('_speed_', '_direction_')} not found`);
			}
			const dimensions = variableReader.getDimensions();
			const readRanges = this.getRanges(ranges, dimensions);

			directions = await variableReader.read({
				type: OmDataType.FloatArray,
				ranges: readRanges,
				intoSAB: this.config.useSAB
			});
		}
		if (variable === 'wave_height') {
			// also get the direction for speed values
			const variableReader = await this.reader.getChildByName(
				variable.replace('wave_height', 'wave_direction')
			);

			if (!variableReader) {
				throw new Error(`Variable ${variable.replace('wave_height', 'wave_direction')} not found`);
			}
			const dimensions = variableReader.getDimensions();
			const readRanges = this.getRanges(ranges, dimensions);

			directions = await variableReader.read({
				type: OmDataType.FloatArray,
				ranges: readRanges,
				intoSAB: this.config.useSAB
			});
		}

		return {
			values: values,
			directions: directions
		};
	}

	private getNextUrls(omUrl: string) {
		const re = new RegExp(/([0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}00)/);
		const matches = omUrl.match(re);
		let nextUrl, prevUrl;
		if (matches) {
			const date = new Date('20' + matches[0].substring(0, matches[0].length - 2) + ':00Z');

			date.setUTCHours(date.getUTCHours() - 1);
			prevUrl = omUrl.replace(
				re,
				`${String(date.getUTCFullYear()).substring(2, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}00`
			);

			date.setUTCHours(date.getUTCHours() + 2);
			nextUrl = omUrl.replace(
				re,
				`${String(date.getUTCFullYear()).substring(2, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}00`
			);
		}
		if (prevUrl && nextUrl) {
			return [prevUrl, nextUrl];
		} else {
			return undefined;
		}
	}

	/**
	 * Prefetches small parts from adjacent files in the time sequence. This is particularly useful
	 * if files are re-distributed via a CDN, with an upstream S3 bucket configured and will essentially
	 * trigger the CDN to cache the file.
	 */
	_prefetch(omUrl: string) {
		const nextOmUrls = this.getNextUrls(omUrl);
		if (nextOmUrls) {
			for (const nextOmUrl of nextOmUrls) {
				// If not already cached, create and cache the backend
				if (!OMapsFileReader.s3BackendCache.has(nextOmUrl)) {
					const s3_backend = new OmHttpBackend({
						url: nextOmUrl,
						eTagValidation: false,
						retries: 2
					});
					OMapsFileReader.s3BackendCache.set(nextOmUrl, s3_backend);
					// Trigger a small fetch to prepare CF to already cache the file
					fetch(nextOmUrl, {
						method: 'GET',
						headers: {
							Range: 'bytes=0-255' // Just fetch first 256 bytes to trigger caching
						}
					}).catch(() => {
						// Silently ignore errors for prefetches
					});
				}
			}
		}
	}

	dispose() {
		if (this.reader) {
			this.reader.dispose();
		}

		delete this.reader;
	}
}
