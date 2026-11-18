/**
 * Builds small GRIB2 messages in memory for the decoder and reader tests:
 * a regular lat/lon grid (template 3.0) with simple packing (template 5.0),
 * optionally behind a bitmap. The real-world complex packing is covered by
 * the fixture file `gfs-rh-7mb.grib2`, a message cut from a GFS inventory.
 */

export interface SyntheticMessage {
	ni: number;
	nj: number;
	/** First grid point, in degrees. */
	lat1: number;
	lon1: number;
	/** Increments, in degrees. */
	di: number;
	dj: number;
	/** Values in scan order; `NaN` marks a bitmapped-out point. */
	values: number[];
	/** Power of ten the values are stored to (2 keeps two decimals). */
	decimalScale?: number;
	/** Scanning mode flags (0: west to east, north to south). */
	scanningMode?: number;
}

const bytesOf = (...parts: ArrayLike<number>[]): Uint8Array => {
	const length = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

const u16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
const u32 = (value: number) => [
	(value >>> 24) & 0xff,
	(value >>> 16) & 0xff,
	(value >>> 8) & 0xff,
	value & 0xff
];
/** GRIB2 signed integer: sign bit then magnitude. */
const s32 = (value: number) => u32((value < 0 ? 0x80000000 : 0) | Math.abs(value));
const s16 = (value: number) => u16((value < 0 ? 0x8000 : 0) | Math.abs(value));
const f32 = (value: number) => {
	const view = new DataView(new ArrayBuffer(4));
	view.setFloat32(0, value);
	return [...new Uint8Array(view.buffer)];
};
const degrees = (value: number) => s32(Math.round(value * 1e6));

const section = (number: number, body: number[]) => [...u32(body.length + 5), number, ...body];

/** Packs `count`-bit unsigned integers, big-endian, padded to whole bytes. */
const packBits = (integers: number[], count: number): number[] => {
	const out: number[] = [];
	let accumulator = 0;
	let filled = 0;
	for (const integer of integers) {
		for (let bit = count - 1; bit >= 0; bit--) {
			accumulator = (accumulator << 1) | ((integer >>> bit) & 1);
			filled++;
			if (filled === 8) {
				out.push(accumulator);
				accumulator = 0;
				filled = 0;
			}
		}
	}
	if (filled > 0) out.push(accumulator << (8 - filled));
	return out;
};

export const buildGrib2Message = (message: SyntheticMessage): Uint8Array => {
	const { ni, nj, values } = message;
	const decimalScale = message.decimalScale ?? 0;
	const present = values.filter((value) => !Number.isNaN(value));
	const scaled = present.map((value) => Math.round(value * 10 ** decimalScale));
	const reference = Math.min(...scaled);
	const range = Math.max(...scaled) - reference;
	const bitsPerValue = range === 0 ? 0 : Math.ceil(Math.log2(range + 1));
	const bitmapped = present.length !== values.length;

	const indicator = [...'GRIB'].map((c) => c.charCodeAt(0));
	const identification = section(1, [
		...u16(7),
		...u16(0),
		2,
		1,
		1,
		...u16(2026),
		10,
		27,
		0,
		0,
		0,
		0,
		1
	]);
	const grid = section(3, [
		0,
		...u32(ni * nj),
		0,
		0,
		...u16(0), // template 3.0
		6,
		0,
		...u32(0),
		0,
		...u32(0),
		0,
		...u32(0),
		...u32(ni),
		...u32(nj),
		...u32(0), // basic angle
		...u32(0xffffffff), // subdivisions
		...degrees(message.lat1),
		...degrees(message.lon1),
		48,
		...degrees(message.lat1 - message.dj * (nj - 1)),
		...degrees(message.lon1 + message.di * (ni - 1)),
		...degrees(message.di),
		...degrees(message.dj),
		message.scanningMode ?? 0
	]);
	const product = section(4, [
		...u16(0),
		...u16(0), // template 4.0
		0,
		0,
		2,
		0,
		0,
		...u16(0),
		0,
		1,
		...u32(3),
		103,
		0,
		...u32(2),
		255,
		0,
		...u32(0)
	]);
	const representation = section(5, [
		...u32(present.length),
		...u16(0), // template 5.0
		...f32(reference),
		...s16(0),
		...s16(decimalScale),
		bitsPerValue,
		0
	]);
	const bitmapBits = values.map((value) => (Number.isNaN(value) ? 0 : 1));
	const bitmap = bitmapped ? section(6, [0, ...packBits(bitmapBits, 1)]) : section(6, [255]);
	const data = section(
		7,
		bitsPerValue === 0
			? []
			: packBits(
					scaled.map((value) => value - reference),
					bitsPerValue
				)
	);
	const end = [...'7777'].map((c) => c.charCodeAt(0));

	const body = bytesOf(identification, grid, product, representation, bitmap, data, end);
	const totalLength = 16 + body.length;
	return bytesOf(
		indicator,
		[0, 0, 0, 2],
		[0, 0, 0, 0],
		u32(totalLength), // low half of the 64-bit length; the high half is zero
		body
	);
};
