/**
 * NCEP `.idx` inventories: one line per GRIB message of the file next to it,
 *
 *   581:406010891:d=2026102700:TMP:2 m above ground:3 hour fcst:
 *
 * giving the message's byte offset, parameter abbreviation, level and time
 * step. A message runs up to the next line's offset, the last one to the end
 * of the file, so a record maps straight onto an HTTP byte range.
 */

export interface GribIndexRecord {
	/** Byte offset of the message in the GRIB file. */
	offset: number;
	/** Last byte of the message, or undefined for the final message of the file. */
	end: number | undefined;
	/** Parameter abbreviation, e.g. `TMP`. */
	name: string;
	/** Level description, e.g. `2 m above ground`. */
	level: string;
	/** Time step description, e.g. `3 hour fcst`, `0-3 hour acc fcst` or `anl`. */
	step: string;
}

/**
 * How a record's time step relates to its valid time: a value at that time,
 * or a statistic over the period before it.
 */
export type GribStepKind = 'instant' | 'average' | 'accumulation' | 'maximum' | 'minimum';

export const parseGribIndex = (text: string): GribIndexRecord[] => {
	const records: GribIndexRecord[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const fields = line.split(':');
		// Index, offset, reference date, name, level, step; later fields hold
		// product specifics (ensemble member, probability) and are not needed
		if (fields.length < 6) continue;
		const offset = Number(fields[1]);
		if (!Number.isInteger(offset)) continue;
		records.push({ offset, end: undefined, name: fields[3], level: fields[4], step: fields[5] });
	}
	for (let i = 0; i + 1 < records.length; i++) {
		records[i].end = records[i + 1].offset - 1;
	}
	return records;
};

const STEP_STATISTIC: Record<string, GribStepKind> = {
	ave: 'average',
	acc: 'accumulation',
	max: 'maximum',
	min: 'minimum'
};

/** The kind of a step description, or undefined for one this reader does not know. */
export const gribStepKind = (step: string): GribStepKind | undefined => {
	if (step === 'anl' || /^\d+ \w+ fcst$/.test(step)) return 'instant';
	const statistic = step.match(/^\d+-\d+ \w+ (\w+) fcst$/)?.[1];
	return statistic ? STEP_STATISTIC[statistic] : undefined;
};

/**
 * The first record of `name` at `level` whose step is of the earliest kind in
 * `kinds` that the index has: a product that writes a field both as an
 * instantaneous value and as a period average gets the one asked for first.
 */
export const findGribRecord = <Record extends GribIndexRecord>(
	records: Record[],
	name: string,
	level: string,
	kinds: GribStepKind[]
): Record | undefined => {
	const candidates = records.filter((record) => record.name === name && record.level === level);
	for (const kind of kinds) {
		const record = candidates.find((candidate) => gribStepKind(candidate.step) === kind);
		if (record) return record;
	}
	return undefined;
};

/** The HTTP `Range` header value fetching exactly this record's message. */
export const gribRecordRange = (record: GribIndexRecord): string =>
	`bytes=${record.offset}-${record.end ?? ''}`;
