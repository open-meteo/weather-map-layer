/**
 * Reads variables from GRIB2 files that come with an NCEP `.idx` inventory,
 * like NOAA's GFS archive on S3. The inventory names every message with its
 * byte offset, so a variable costs one small index fetch and one range
 * request for its message; nothing else of the multi-hundred-megabyte file is
 * downloaded. The message is decoded in full (GRIB packs the whole grid as
 * one unit), cached, and the requested range is cut from it.
 *
 * The URL is that of the index file; the GRIB file is the same URL without
 * the `.idx` suffix, as NCEP lays them out.
 */
import {
	type VariableDerivationRule,
	applyDerivation,
	resolveDerivation,
	variableAvailable
} from '../derivation-rules';

import { gfsCompanionIndexUrls, gfsGribVariable, gfsStoredVariables } from './gfs';
import { decodeGrib2, toSouthWestOrigin } from './grib2-decoder';
import {
	type GribIndexRecord,
	findGribRecord,
	gribRecordRange,
	parseGribIndex
} from './grib-index';

import type { Data, DimensionRange } from '../types';

export interface GribReaderConfig {
	useSAB: boolean;
	retries: number;
	derivationRules: VariableDerivationRule[];
}

/** Whether a data URL names a GRIB index file rather than an `.om` file. */
export const isGribIndexUrl = (url: string): boolean => url.endsWith('.idx');

/** An index record together with the GRIB file it points into. */
interface FileRecord extends GribIndexRecord {
	fileUrl: string;
}

/** The records a read can draw on, and the variable names they serve. */
interface GribSource {
	records: FileRecord[];
	stored: ReadonlySet<string>;
}

/** One decoded message in this library's grid layout, converted to Open-Meteo's unit. */
interface DecodedField {
	values: Float32Array;
	nx: number;
	ny: number;
	scaleFactor: number;
}

interface FieldEntry {
	promise: Promise<DecodedField>;
	controller: AbortController;
	subscribers: number;
	settled: boolean;
	bytes: number;
}

/** Inventories kept: a few runs' worth of time steps, at some 40 kB each. */
const INDEX_CACHE_MAX = 64;
/** Decoded fields kept, by size: a 0.25° field is 4 MB, a surface flux field 19 MB. */
const FIELD_CACHE_BYTES = 96 * 1024 * 1024;

export class GribFileReader {
	private readonly indexes = new Map<string, Promise<FileRecord[]>>();
	private readonly fields = new Map<string, FieldEntry>();
	private fieldBytes = 0;

	constructor(private readonly config: GribReaderConfig) {}

	/**
	 * Read `variable` for `ranges` of the grid (all of it when null) from the
	 * GRIB file indexed by `indexUrl`, through the derivation rules where one
	 * claims the variable. Precipitation and showers come as rates from GFS,
	 * so they are per hour without a time step, and `deltaTimeHours` is only
	 * handed to rules asking for it.
	 */
	async readVariable(
		indexUrl: string,
		variable: string,
		ranges: DimensionRange[] | null,
		signal?: AbortSignal,
		deltaTimeHours?: number
	): Promise<Data> {
		const source = await this.openSource(indexUrl, variable, signal);
		const derivation = resolveDerivation(
			this.config.derivationRules,
			variable,
			source.stored,
			deltaTimeHours
		);
		const names = derivation ? derivation.sourceVars : [variable];
		const fields = await Promise.all(names.map((name) => this.readField(source, name, signal)));
		// Rules work per cell, so they run on the requested range only
		const sliced = fields.map((field) => sliceField(field, ranges, this.config.useSAB));
		if (derivation) {
			return applyDerivation(derivation, sliced, fields[0].scaleFactor, this.config.useSAB);
		}
		return { values: sliced[0], directions: undefined, scaleFactor: fields[0].scaleFactor };
	}

	/** Fetch and decode the messages a read of `variable` needs, into the field cache. */
	async prefetchVariable(indexUrl: string, variable: string, signal?: AbortSignal): Promise<void> {
		const source = await this.openSource(indexUrl, variable, signal);
		const derivation = resolveDerivation(
			this.config.derivationRules,
			variable,
			source.stored,
			undefined,
			true
		);
		const names = derivation ? derivation.sourceVars : [variable];
		await Promise.all(names.map((name) => this.readField(source, name, signal)));
	}

	/** Fetch the inventory, so a later read only pays for its message. */
	async warmIndex(indexUrl: string): Promise<void> {
		await this.index(indexUrl);
	}

	/** Drop every cached inventory and decoded field. */
	clear(): void {
		this.indexes.clear();
		this.fields.clear();
		this.fieldBytes = 0;
	}

	/**
	 * The index behind `indexUrl`, joined with its companion files when the
	 * variable is neither stored in nor derivable from the primary one.
	 */
	private async openSource(
		indexUrl: string,
		variable: string,
		signal?: AbortSignal
	): Promise<GribSource> {
		let records = await this.index(indexUrl);
		let stored = gfsStoredVariables(records);
		if (!variableAvailable(variable, stored, this.config.derivationRules)) {
			for (const companion of gfsCompanionIndexUrls(indexUrl)) {
				signal?.throwIfAborted();
				try {
					records = records.concat(await this.index(companion));
				} catch {
					// A time step without the companion file has nothing more to offer
				}
			}
			stored = gfsStoredVariables(records);
		}
		return { records, stored };
	}

	private index(indexUrl: string): Promise<FileRecord[]> {
		let pending = this.indexes.get(indexUrl);
		if (!pending) {
			const fileUrl = indexUrl.slice(0, -'.idx'.length);
			pending = this.fetchWithRetries(indexUrl)
				.then((response) => response.text())
				.then((text) => parseGribIndex(text).map((record) => ({ ...record, fileUrl })));
			// A failed fetch is not kept, so the next read retries it
			pending.catch(() => this.indexes.delete(indexUrl));
			this.indexes.set(indexUrl, pending);
			if (this.indexes.size > INDEX_CACHE_MAX) {
				this.indexes.delete(this.indexes.keys().next().value!);
			}
		}
		return pending;
	}

	/**
	 * The decoded message of `variable`, shared between concurrent readers and
	 * cached afterwards. The download is abandoned once every reader waiting
	 * for it has aborted.
	 */
	private readField(source: GribSource, variable: string, signal?: AbortSignal) {
		signal?.throwIfAborted();
		const spec = gfsGribVariable(variable);
		if (!spec) {
			throw new Error(`Variable ${variable} has no GFS GRIB record`);
		}
		const record = findGribRecord(source.records, spec.name, spec.level, spec.steps ?? ['instant']);
		if (!record) {
			throw new Error(`Variable: ${variable} not found`);
		}

		const key = `${record.fileUrl}#${record.offset}`;
		let entry = this.fields.get(key);
		if (entry) {
			// Re-insert to keep insertion order as LRU order
			this.fields.delete(key);
			this.fields.set(key, entry);
		} else {
			const controller = new AbortController();
			const created: FieldEntry = {
				promise: this.loadField(record, spec, controller.signal),
				controller,
				subscribers: 0,
				settled: false,
				bytes: 0
			};
			entry = created;
			this.fields.set(key, created);
			created.promise.then(
				(field) => {
					created.settled = true;
					created.bytes = field.values.byteLength;
					this.fieldBytes += created.bytes;
					this.evictFields(key);
				},
				() => {
					created.settled = true;
					if (this.fields.get(key) === created) this.fields.delete(key);
				}
			);
		}
		return this.subscribe(key, entry, signal);
	}

	private async subscribe(
		key: string,
		entry: FieldEntry,
		signal?: AbortSignal
	): Promise<DecodedField> {
		entry.subscribers += 1;
		const onAbort = () => {
			entry.subscribers -= 1;
			if (entry.subscribers <= 0 && !entry.settled) {
				entry.controller.abort();
				if (this.fields.get(key) === entry) this.fields.delete(key);
			}
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		try {
			return await entry.promise;
		} finally {
			// An aborted signal already ran `onAbort`
			if (!signal?.aborted) {
				signal?.removeEventListener('abort', onAbort);
				entry.subscribers -= 1;
			}
		}
	}

	/** Drops the least recently used settled fields until the cache fits, keeping `keep`. */
	private evictFields(keep: string): void {
		for (const [key, entry] of this.fields) {
			if (this.fieldBytes <= FIELD_CACHE_BYTES) break;
			if (key === keep || !entry.settled) continue;
			this.fields.delete(key);
			this.fieldBytes -= entry.bytes;
		}
	}

	private async loadField(
		record: FileRecord,
		spec: NonNullable<ReturnType<typeof gfsGribVariable>>,
		signal: AbortSignal
	): Promise<DecodedField> {
		const response = await this.fetchWithRetries(record.fileUrl, gribRecordRange(record), signal);
		let bytes = new Uint8Array(await response.arrayBuffer());
		// A server ignoring the Range header sends the whole file
		if (response.status === 200) {
			bytes = bytes.subarray(record.offset, record.end === undefined ? undefined : record.end + 1);
		}

		const field = decodeGrib2(bytes);
		const values = toSouthWestOrigin(field);
		const multiply = spec.multiply ?? 1;
		const add = spec.add ?? 0;
		if (multiply !== 1 || add !== 0) {
			for (let i = 0; i < values.length; i++) values[i] = values[i] * multiply + add;
		}
		return {
			values,
			nx: field.ni,
			ny: field.nj,
			// The packing's step, in the converted unit
			scaleFactor: 1 / (field.quantum * Math.abs(multiply))
		};
	}

	/** `fetch` retried on network errors and server errors, never on a client error or abort. */
	private async fetchWithRetries(
		url: string,
		range?: string,
		signal?: AbortSignal
	): Promise<Response> {
		for (let attempt = 0; ; attempt++) {
			try {
				const response = await fetch(url, {
					headers: range ? { Range: range } : undefined,
					signal
				});
				if (response.ok) return response;
				const error = new Error(`Failed to fetch ${url}: ${response.status}`);
				if (response.status < 500 || attempt >= this.config.retries) throw error;
			} catch (error) {
				if (signal?.aborted || attempt >= this.config.retries) throw error;
			}
		}
	}
}

/** The values of `ranges` (rows, then columns) of a field, in a fresh array. */
const sliceField = (
	field: DecodedField,
	ranges: DimensionRange[] | null,
	useSAB: boolean
): Float32Array => {
	const [rows, columns] = ranges ?? [
		{ start: 0, end: field.ny },
		{ start: 0, end: field.nx }
	];
	if (rows.end > field.ny || columns.end > field.nx || rows.start < 0 || columns.start < 0) {
		throw new Error(
			`Requested range exceeds the ${field.nx}x${field.ny} GRIB grid: the domain's grid does not match the file`
		);
	}
	const width = columns.end - columns.start;
	const height = rows.end - rows.start;
	const byteLength = width * height * 4;
	const out = new Float32Array(
		useSAB ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength)
	);
	for (let row = 0; row < height; row++) {
		const start = (rows.start + row) * field.nx + columns.start;
		out.set(field.values.subarray(start, start + width), row * width);
	}
	return out;
};
