import { OmDataType, OmHttpBackend, type OmFileReader } from '@openmeteo/file-reader';

import { pad } from './utils';

import type { Data } from './om-protocol';

import type { Domain, DimensionRange, Variable } from './types';

import { fastAtan2, radiansToDegrees } from './utils/math';

import {
	DynamicProjection,
	ProjectionGrid,
	type Projection,
	type ProjectionName
} from './utils/projections';

import { MS_TO_KNOTS } from './utils/constants';

export class OMapsFileReader {
	static s3BackendCache: Map<string, OmHttpBackend> = new Map();

	child?: OmFileReader;
	reader?: OmFileReader;

	partial!: boolean;
	ranges!: DimensionRange[];

	useSAB!: boolean;
	domain!: Domain;
	projection!: Projection;
	projectionGrid!: ProjectionGrid;

	constructor(domain: Domain, partial: boolean, useSAB: boolean) {
		this.setReaderData(domain, partial);
		this.useSAB = useSAB;
	}

	async init(omUrl: string) {
		this.dispose();
		let s3_backend = OMapsFileReader.s3BackendCache.get(omUrl);
		if (!s3_backend) {
			s3_backend = new OmHttpBackend({
				url: omUrl,
				eTagValidation: false,
				retries: 2
			});
			OMapsFileReader.s3BackendCache.set(omUrl, s3_backend);
		}
		this.reader = await s3_backend.asCachedReader();
	}

	setReaderData(domain: Domain, partial: boolean) {
		this.partial = partial;
		this.domain = domain;
		if (domain.grid.projection) {
			const projectionName = domain.grid.projection.name;
			this.projection = new DynamicProjection(
				projectionName as ProjectionName,
				domain.grid.projection
			) as Projection;
			this.projectionGrid = new ProjectionGrid(this.projection, domain.grid);
		}
	}

	setRanges(ranges: DimensionRange[] | null, dimensions: number[] | undefined) {
		if (this.partial || !dimensions) {
			this.ranges = ranges ?? this.ranges;
		} else {
			this.ranges = [
				{ start: 0, end: dimensions[0] },
				{ start: 0, end: dimensions[1] }
			];
		}
	}

	async readVariable(variable: Variable, ranges: DimensionRange[] | null = null): Promise<Data> {
		let values, directions: Float32Array | undefined;
		if (variable.value.includes('_u_component')) {
			// combine uv components, and calculate directions
			const variableReaderU = await this.reader?.getChildByName(variable.value);
			const variableReaderV = await this.reader?.getChildByName(
				variable.value.replace('_u_component', '_v_component')
			);
			const dimensions = variableReaderU?.getDimensions();

			this.setRanges(ranges, dimensions);

			const valuesUPromise = variableReaderU?.read({
				type: OmDataType.FloatArray,
				ranges: this.ranges,
				intoSAB: this.useSAB
			});
			const valuesVPromise = variableReaderV?.read({
				type: OmDataType.FloatArray,
				ranges: this.ranges,
				intoSAB: this.useSAB
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
				if (variable.value.includes('wind')) {
					values[i] = Math.sqrt(u * u + v * v) * MS_TO_KNOTS;
				} else {
					values[i] = Math.sqrt(u * u + v * v);
				}
				directions[i] = (radiansToDegrees(fastAtan2(u, v)) + 180) % 360;
			}
		} else {
			const variableReader = await this.reader?.getChildByName(variable.value);
			const dimensions = variableReader?.getDimensions();

			this.setRanges(ranges, dimensions);

			values = await variableReader?.read({
				type: OmDataType.FloatArray,
				ranges: this.ranges,
				intoSAB: this.useSAB
			});
		}

		if (variable.value.includes('_speed_')) {
			// also get the direction for speed values
			const variableReader = await this.reader?.getChildByName(
				variable.value.replace('_speed_', '_direction_')
			);

			directions = await variableReader?.read({
				type: OmDataType.FloatArray,
				ranges: this.ranges,
				intoSAB: this.useSAB
			});
		}
		if (variable.value === 'wave_height') {
			// also get the direction for speed values
			const variableReader = await this.reader?.getChildByName(
				variable.value.replace('wave_height', 'wave_direction')
			);

			directions = await variableReader?.read({
				type: OmDataType.FloatArray,
				ranges: this.ranges,
				intoSAB: this.useSAB
			});
		}

		return {
			values: values,
			directions: directions
		};
	}

	getNextUrls(omUrl: string) {
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

	prefetch(omUrl: string) {
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
		if (this.child) {
			this.child.dispose();
		}
		if (this.reader) {
			this.reader.dispose();
		}

		delete this.child;
		delete this.reader;
	}
}
