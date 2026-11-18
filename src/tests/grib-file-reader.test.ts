/**
 * The indexed-GRIB reader against a fake NOAA bucket: `fetch` serves an
 * inventory and byte ranges of a GRIB file assembled from synthetic messages,
 * so the tests check what is requested as much as what comes back.
 */
import { defaultDerivationRules } from '../derivation-rules';
import { GribFileReader } from '../grib/grib-file-reader';
import { WeatherMapLayerFileReader } from '../om-file-reader';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type SyntheticMessage, buildGrib2Message } from './grib2-fixtures';

const BUCKET = 'https://bucket.example/gfs.20261027/00/atmos/';
const PGRB2 = BUCKET + 'gfs.t00z.pgrb2.0p25.f003';
const PGRB2B = BUCKET + 'gfs.t00z.pgrb2b.0p25.f003';

// A 4 x 2 global grid: columns at 0°, 90°, 180°, 270°, rows at 45° N and 45° S
const grid = { ni: 4, nj: 2, lat1: 45, lon1: 0, di: 90, dj: 90 };
/** A field in scan order, so that `[a, b, c, d, e, f, g, h]` reads south-west first as `[g, h, e, f, c, d, a, b]`. */
const message = (values: number[], decimalScale = 2): Partial<SyntheticMessage> => ({
	values,
	decimalScale
});

/** Builds a GRIB file and its index from `records`, keyed by `NAME:level:step`. */
const buildFile = (records: Record<string, Partial<SyntheticMessage>>) => {
	const messages = Object.entries(records).map(([key, overrides]) => ({
		key,
		bytes: buildGrib2Message({ ...grid, values: [], ...overrides })
	}));
	const length = messages.reduce((sum, m) => sum + m.bytes.length, 0);
	const file = new Uint8Array(length);
	const lines: string[] = [];
	let offset = 0;
	messages.forEach((m, i) => {
		file.set(m.bytes, offset);
		lines.push(`${i + 1}:${offset}:d=2026102700:${m.key}:`);
		offset += m.bytes.length;
	});
	return { file, index: lines.join('\n') + '\n' };
};

/** The values rounded to two decimals; `+ 0` turns a `-0` of the Kelvin offset into `0`. */
const rounded = (values: Float32Array | undefined, decimals = 2): number[] =>
	[...values!].map((v) => Math.round(v * 10 ** decimals) / 10 ** decimals + 0);

/** Every request `fetch` saw, as `[url, Range header]`. */
let requests: [string, string | undefined][];

/** Serves `files` (GRIB bytes by URL) with their `.idx` inventories, honouring `Range`. */
const serve = (files: Record<string, { file: Uint8Array; index: string }>, rangeSupport = true) => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const range = (init?.headers as Record<string, string> | undefined)?.Range;
			requests.push([url, range]);
			if (url.endsWith('.idx')) {
				const entry = files[url.slice(0, -'.idx'.length)];
				return entry
					? new Response(entry.index, { status: 200 })
					: new Response('missing', { status: 404 });
			}
			const entry = files[url];
			if (!entry) return new Response('missing', { status: 404 });
			if (!range || !rangeSupport) return new Response(entry.file, { status: 200 });
			const [, start, end] = range.match(/^bytes=(\d+)-(\d*)$/)!;
			const slice = entry.file.subarray(Number(start), end ? Number(end) + 1 : undefined);
			return new Response(slice, { status: 206 });
		})
	);
};

const createReader = () =>
	new GribFileReader({ useSAB: false, retries: 1, derivationRules: defaultDerivationRules });

beforeEach(() => {
	requests = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('GribFileReader', () => {
	it('reads a variable from its message only, converted and in grid layout', async () => {
		serve({
			[PGRB2]: buildFile({
				'PRMSL:mean sea level:3 hour fcst': message([1, 2, 3, 4, 5, 6, 7, 8]),
				// Kelvin, in scan order: north row then south row
				'TMP:2 m above ground:3 hour fcst': message([
					273.15, 274.15, 275.15, 276.15, 283.15, 284.15, 285.15, 286.15
				])
			})
		});

		const data = await createReader().readVariable(PGRB2 + '.idx', 'temperature_2m', null);

		// South row first, starting at 180° W (the third column of the message)
		expect(rounded(data.values)).toEqual([12, 13, 10, 11, 2, 3, 0, 1]);
		expect(data.directions).toBeUndefined();
		expect(data.scaleFactor).toBeCloseTo(100, 6);

		const [indexRequest, messageRequest] = requests;
		expect(indexRequest).toEqual([PGRB2 + '.idx', undefined]);
		expect(messageRequest[0]).toBe(PGRB2);
		// Exactly the second message's bytes
		const firstLength = buildGrib2Message({ ...grid, ...message([1, 2, 3, 4, 5, 6, 7, 8]) }).length;
		expect(messageRequest[1]).toBe(`bytes=${firstLength}-`);
		expect(requests).toHaveLength(2);
	});

	it('cuts the requested ranges from the field', async () => {
		serve({
			[PGRB2]: buildFile({
				'TMP:2 m above ground:3 hour fcst': message([
					273.15, 274.15, 275.15, 276.15, 283.15, 284.15, 285.15, 286.15
				])
			})
		});

		const data = await createReader().readVariable(PGRB2 + '.idx', 'temperature_2m', [
			{ start: 1, end: 2 },
			{ start: 1, end: 3 }
		]);

		expect(rounded(data.values)).toEqual([3, 0]);
	});

	it('rejects ranges outside the file grid, which means the domain does not match', async () => {
		serve({
			[PGRB2]: buildFile({ 'TMP:2 m above ground:3 hour fcst': message([1, 2, 3, 4, 5, 6, 7, 8]) })
		});

		await expect(
			createReader().readVariable(PGRB2 + '.idx', 'temperature_2m', [
				{ start: 0, end: 3 },
				{ start: 0, end: 4 }
			])
		).rejects.toThrow('does not match');
	});

	it('derives through the rules, reading each source message once', async () => {
		serve({
			[PGRB2]: buildFile({
				'UGRD:10 m above ground:3 hour fcst': message([3, 3, 3, 3, 3, 3, 3, 3]),
				'VGRD:10 m above ground:3 hour fcst': message([4, 4, 4, 4, 4, 4, 4, 4])
			})
		});

		const data = await createReader().readVariable(PGRB2 + '.idx', 'wind_speed_10m', null);

		expect([...data.values!]).toEqual([5, 5, 5, 5, 5, 5, 5, 5]);
		expect(data.directions).toHaveLength(8);
		// Index, then one range request per component
		expect(requests.map(([url]) => url)).toEqual([PGRB2 + '.idx', PGRB2, PGRB2]);
	});

	it('turns the precipitation rate into millimetres per hour', async () => {
		serve({
			[PGRB2]: buildFile({
				// kg/m²/s, 0.001 is 3.6 mm/h
				'PRATE:surface:3 hour fcst': message([0, 0.001, 0, 0, 0, 0, 0, 0.002], 3),
				'PRATE:surface:0-3 hour ave fcst': message([9, 9, 9, 9, 9, 9, 9, 9])
			})
		});

		const data = await createReader().readVariable(PGRB2 + '.idx', 'precipitation', null);

		expect(rounded(data.values, 3)).toEqual([0, 7.2, 0, 0, 0, 0, 0, 3.6]);
	});

	it('serves repeat reads from the decoded field', async () => {
		serve({
			[PGRB2]: buildFile({ 'TMP:2 m above ground:3 hour fcst': message([1, 2, 3, 4, 5, 6, 7, 8]) })
		});
		const reader = createReader();

		await reader.readVariable(PGRB2 + '.idx', 'temperature_2m', null);
		await reader.readVariable(PGRB2 + '.idx', 'temperature_2m', [
			{ start: 0, end: 1 },
			{ start: 0, end: 1 }
		]);

		expect(requests).toHaveLength(2);
	});

	it('consults the companion index only for a variable the primary one lacks', async () => {
		serve({
			[PGRB2]: buildFile({ 'TMP:2 m above ground:3 hour fcst': message([1, 2, 3, 4, 5, 6, 7, 8]) }),
			[PGRB2B]: buildFile({
				'TMP:875 mb:3 hour fcst': message([
					273.15, 273.15, 273.15, 273.15, 273.15, 273.15, 273.15, 273.15
				])
			})
		});
		const reader = createReader();

		await reader.readVariable(PGRB2 + '.idx', 'temperature_2m', null);
		expect(requests.map(([url]) => url)).not.toContain(PGRB2B + '.idx');

		const data = await reader.readVariable(PGRB2 + '.idx', 'temperature_875hPa', null);
		expect(rounded(data.values)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
		expect(requests.map(([url]) => url)).toEqual([PGRB2 + '.idx', PGRB2, PGRB2B + '.idx', PGRB2B]);
	});

	it('reports a variable the inventories do not hold', async () => {
		serve({
			[PGRB2]: buildFile({ 'TMP:2 m above ground:3 hour fcst': message([1, 2, 3, 4, 5, 6, 7, 8]) })
		});

		await expect(
			createReader().readVariable(PGRB2 + '.idx', 'wind_gusts_10m', null)
		).rejects.toThrow('wind_gusts_10m not found');
		await expect(createReader().readVariable(PGRB2 + '.idx', 'pm2_5', null)).rejects.toThrow(
			'no GFS GRIB record'
		);
	});

	it('cuts the message itself out of a response to an ignored Range header', async () => {
		serve(
			{
				[PGRB2]: buildFile({
					'PRMSL:mean sea level:3 hour fcst': message([1, 2, 3, 4, 5, 6, 7, 8]),
					'TMP:2 m above ground:3 hour fcst': message([
						273.15, 273.15, 273.15, 273.15, 273.15, 273.15, 273.15, 273.15
					])
				})
			},
			false
		);

		const data = await createReader().readVariable(PGRB2 + '.idx', 'temperature_2m', null);

		expect(rounded(data.values)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
	});

	it('fails a read whose signal is aborted', async () => {
		serve({
			[PGRB2]: buildFile({ 'TMP:2 m above ground:3 hour fcst': message([1, 2, 3, 4, 5, 6, 7, 8]) })
		});
		const controller = new AbortController();
		controller.abort();

		await expect(
			createReader().readVariable(PGRB2 + '.idx', 'temperature_2m', null, controller.signal)
		).rejects.toThrow();
	});

	it('prefetches the messages of a derived variable', async () => {
		serve({
			[PGRB2]: buildFile({
				'UGRD:10 m above ground:3 hour fcst': message([3, 3, 3, 3, 3, 3, 3, 3]),
				'VGRD:10 m above ground:3 hour fcst': message([4, 4, 4, 4, 4, 4, 4, 4])
			})
		});
		const reader = createReader();

		await reader.prefetchVariable(PGRB2 + '.idx', 'wind_speed_10m');
		expect(requests).toHaveLength(3);

		await reader.readVariable(PGRB2 + '.idx', 'wind_speed_10m', null);
		expect(requests).toHaveLength(3);
	});
});

describe('WeatherMapLayerFileReader with an index URL', () => {
	it('reads it as an indexed GRIB file', async () => {
		serve({
			[PGRB2]: buildFile({
				'TMP:2 m above ground:3 hour fcst': message([
					274.15, 274.15, 274.15, 274.15, 274.15, 274.15, 274.15, 274.15
				])
			})
		});
		const reader = new WeatherMapLayerFileReader({ useSAB: false, retries: 0 });

		const data = await reader.readVariable(PGRB2 + '.idx', 'temperature_2m');

		expect(rounded(data.values)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
	});

	it('reads precipitation without a time step, as GFS stores a rate', async () => {
		serve({
			[PGRB2]: buildFile({
				'PRATE:surface:3 hour fcst': message(
					[0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001],
					3
				)
			})
		});
		const reader = new WeatherMapLayerFileReader({ useSAB: false, retries: 0 });

		const data = await reader.readVariable(PGRB2 + '.idx', 'precipitation');

		expect(rounded(data.values, 1)).toEqual([3.6, 3.6, 3.6, 3.6, 3.6, 3.6, 3.6, 3.6]);
	});
});
