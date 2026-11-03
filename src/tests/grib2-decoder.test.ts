/**
 * The GRIB2 decoder, against a message cut from a real GFS inventory
 * (complex packing with spatial differencing, the template every GFS field
 * uses) with values checked against ecCodes' `grib_get_data`, and against
 * synthetic simple-packed messages for the layouts the real one does not show.
 */
import { decodeGrib2, toSouthWestOrigin } from '../grib/grib2-decoder';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildGrib2Message } from './grib2-fixtures';

// RH at 7 hPa, GFS 0.25°, run 2026-10-27 00Z, 3 hour forecast
const fixture = new Uint8Array(
	readFileSync(new URL('./fixtures/gfs-rh-7mb.grib2', import.meta.url))
);

describe('decodeGrib2', () => {
	describe('GFS message with complex packing and spatial differencing', () => {
		const field = decodeGrib2(fixture);

		it('reads the lat/lon grid definition', () => {
			expect(field.ni).toBe(1440);
			expect(field.nj).toBe(721);
			expect(field.lat1).toBe(90);
			expect(field.lon1).toBe(0);
			expect(field.di).toBe(0.25);
			expect(field.jScansNegatively).toBe(true);
			expect(field.iScansNegatively).toBe(false);
			expect(field.values.length).toBe(1440 * 721);
		});

		it('decodes the values ecCodes reads', () => {
			// Scan-order index: row from the north pole, column from 0° eastwards
			const at = (lat: number, lon: number) => ((90 - lat) / 0.25) * 1440 + lon / 0.25;
			expect(field.values[at(90, 0)]).toBeCloseTo(0.7, 5);
			expect(field.values[at(90, 0.25)]).toBeCloseTo(0.7, 5);
			expect(field.values[at(89.75, 0)]).toBeCloseTo(0.7, 5);
			expect(field.values[at(45, 10)]).toBeCloseTo(0.1, 5);
			expect(field.values[at(0, 0)]).toBe(0);
			expect(field.values[at(-33.75, 151.25)]).toBe(0);
			expect(field.values[at(-90, 359.75)]).toBe(0);

			let min = Infinity;
			let max = -Infinity;
			let sum = 0;
			for (const value of field.values) {
				min = Math.min(min, value);
				max = Math.max(max, value);
				sum += value;
			}
			expect(min).toBe(0);
			expect(max).toBeCloseTo(1.3, 5);
			expect(sum / field.values.length).toBeCloseTo(0.0949746, 6);
		});

		it('has the quantum of the decimal scaling', () => {
			expect(field.quantum).toBeCloseTo(0.1, 10);
		});
	});

	describe('simple packing', () => {
		it('round-trips values to the stored precision', () => {
			const values = [1.25, -3.5, 0, 12.75, 7.5, 7.5];
			const field = decodeGrib2(
				buildGrib2Message({
					ni: 3,
					nj: 2,
					lat1: 10,
					lon1: 100,
					di: 1,
					dj: 1,
					values,
					decimalScale: 2
				})
			);
			expect([...field.values]).toEqual(values);
			expect(field.quantum).toBeCloseTo(0.01, 10);
			expect(field.lat1).toBe(10);
			expect(field.lon1).toBe(100);
			expect(field.di).toBe(1);
		});

		it('decodes a constant field stored with zero bits per value', () => {
			const field = decodeGrib2(
				buildGrib2Message({ ni: 2, nj: 2, lat1: 1, lon1: 1, di: 1, dj: 1, values: [4, 4, 4, 4] })
			);
			expect([...field.values]).toEqual([4, 4, 4, 4]);
		});

		it('fills bitmapped-out points with NaN', () => {
			const field = decodeGrib2(
				buildGrib2Message({
					ni: 3,
					nj: 1,
					lat1: 1,
					lon1: 1,
					di: 1,
					dj: 1,
					values: [1, NaN, 3]
				})
			);
			expect(field.values[0]).toBe(1);
			expect(field.values[1]).toBeNaN();
			expect(field.values[2]).toBe(3);
		});

		it('ignores bytes after the message', () => {
			const message = buildGrib2Message({
				ni: 1,
				nj: 1,
				lat1: 0,
				lon1: 0,
				di: 1,
				dj: 1,
				values: [2]
			});
			const padded = new Uint8Array(message.length + 10);
			padded.set(message);
			expect([...decodeGrib2(padded).values]).toEqual([2]);
		});
	});

	describe('rejects what it cannot decode', () => {
		it('rejects data that is not a GRIB message', () => {
			expect(() => decodeGrib2(new Uint8Array(32))).toThrow('Not a GRIB message');
		});

		it('rejects a truncated message', () => {
			const message = buildGrib2Message({
				ni: 2,
				nj: 1,
				lat1: 0,
				lon1: 0,
				di: 1,
				dj: 1,
				values: [1, 2]
			});
			expect(() => decodeGrib2(message.subarray(0, message.length - 20))).toThrow('Truncated');
		});

		it('names an unsupported data representation template', () => {
			const message = buildGrib2Message({
				ni: 2,
				nj: 1,
				lat1: 0,
				lon1: 0,
				di: 1,
				dj: 1,
				values: [1, 2]
			});
			// Section 5 follows sections 1 (21 bytes), 3 (72) and 4 (34) after the
			// 16-byte indicator; its template number sits at offset 9
			const section5 = 16 + 21 + 72 + 34;
			message[section5 + 9] = 0;
			message[section5 + 10] = 40;
			expect(() => decodeGrib2(message)).toThrow('template 5.40');
		});
	});
});

describe('toSouthWestOrigin', () => {
	it('flips a north-to-south global field and starts its columns at 180° W', () => {
		// 4 columns at 0°, 90°, 180°, 270°; 2 rows at 45° N and 45° S
		const field = decodeGrib2(
			buildGrib2Message({
				ni: 4,
				nj: 2,
				lat1: 45,
				lon1: 0,
				di: 90,
				dj: 90,
				values: [0, 90, 180, 270, 1000, 1090, 1180, 1270]
			})
		);
		expect([...toSouthWestOrigin(field)]).toEqual([1180, 1270, 1000, 1090, 180, 270, 0, 90]);
	});

	it('keeps the columns of a regional field', () => {
		const field = decodeGrib2(
			buildGrib2Message({
				ni: 2,
				nj: 2,
				lat1: 50,
				lon1: 5,
				di: 1,
				dj: 1,
				values: [1, 2, 3, 4]
			})
		);
		expect([...toSouthWestOrigin(field)]).toEqual([3, 4, 1, 2]);
	});

	it('keeps the rows of a south-to-north field', () => {
		const field = decodeGrib2(
			buildGrib2Message({
				ni: 2,
				nj: 2,
				lat1: 49,
				lon1: 5,
				di: 1,
				dj: 1,
				values: [1, 2, 3, 4],
				scanningMode: 0x40
			})
		);
		expect([...toSouthWestOrigin(field)]).toEqual([1, 2, 3, 4]);
	});

	it('puts the GFS field in the layout of the ncep_gfs025 grid', () => {
		const field = decodeGrib2(fixture);
		const values = toSouthWestOrigin(field);
		const at = (lat: number, lon: number) => ((lat + 90) / 0.25) * 1440 + (lon + 180) / 0.25;
		expect(values[at(45, 10)]).toBeCloseTo(0.1, 5);
		expect(values[at(90, -180)]).toBeCloseTo(0.7, 5);
		// The first value is the south pole at 180° W: in scan order the last
		// row, half a row in
		expect(values[0]).toBe(field.values[720 * 1440 + 720]);
	});
});
