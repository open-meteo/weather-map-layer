/**
 * GRIB2 decoder for the messages the indexed-GRIB reader fetches by byte
 * range, one message at a time. It covers what NCEP writes for the GFS
 * products: grid templates 3.0 (regular lat/lon) and 3.40 (Gaussian) in plain
 * row-major scan order, data templates 5.0 (simple packing), 5.2 (complex
 * packing) and 5.3 (complex packing with spatial differencing), and an
 * optional bitmap. Anything else is rejected with an error naming the template.
 *
 * The algorithms follow NCEP's g2clib (`simunpack.c`, `comunpack.c`), which
 * is the reference implementation of these templates.
 */

/** One decoded field, as laid out in the message. */
export interface Grib2Field {
	/** Points along a parallel (columns) and number of parallels (rows). */
	ni: number;
	nj: number;
	/** First grid point, in degrees. */
	lat1: number;
	lon1: number;
	/** Longitude increment, in degrees. */
	di: number;
	/** Rows run north to south (the usual NCEP order) / columns run east to west. */
	jScansNegatively: boolean;
	iScansNegatively: boolean;
	/** The values in scan order, `NaN` where the bitmap masks a point. */
	values: Float32Array;
	/** Smallest step between two packed values: 2^E / 10^D of the packing. */
	quantum: number;
}

interface GridDefinition {
	ni: number;
	nj: number;
	lat1: number;
	lon1: number;
	di: number;
	jScansNegatively: boolean;
	iScansNegatively: boolean;
}

interface DataRepresentation {
	numberOfValues: number;
	template: number;
	referenceValue: number;
	binaryScale: number;
	decimalScale: number;
	bitsPerValue: number;
	// Complex packing (templates 5.2 and 5.3)
	missingValueManagement: number;
	numberOfGroups: number;
	referenceGroupWidth: number;
	bitsPerGroupWidth: number;
	referenceGroupLength: number;
	groupLengthIncrement: number;
	lastGroupLength: number;
	bitsPerGroupLength: number;
	// Spatial differencing (template 5.3)
	differencingOrder: number;
	descriptorOctets: number;
}

const GRIB_MAGIC = 0x47524942; // "GRIB"
const END_MAGIC = 0x37373737; // "7777"

/**
 * Decodes the GRIB2 message at the start of `bytes`. Trailing bytes after the
 * message are ignored, so the slice an index byte range yields can be passed
 * as is.
 */
export const decodeGrib2 = (bytes: Uint8Array): Grib2Field => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 16 || view.getUint32(0) !== GRIB_MAGIC) {
		throw new Error('Not a GRIB message');
	}
	if (bytes[7] !== 2) {
		throw new Error(`GRIB edition ${bytes[7]} is not supported`);
	}
	const totalLength = Number(view.getBigUint64(8));
	if (totalLength > bytes.length) {
		throw new Error(`Truncated GRIB message: ${bytes.length} of ${totalLength} bytes`);
	}

	let grid: GridDefinition | undefined;
	let representation: DataRepresentation | undefined;
	let bitmap: Uint8Array | undefined;
	let data: Uint8Array | undefined;

	let position = 16;
	while (position + 4 <= totalLength) {
		if (view.getUint32(position) === END_MAGIC) break;
		const length = view.getUint32(position);
		const number = bytes[position + 4];
		const section = bytes.subarray(position, position + length);
		switch (number) {
			case 3:
				grid = parseGridDefinition(section);
				break;
			case 5:
				representation = parseDataRepresentation(section);
				break;
			case 6:
				bitmap = parseBitmap(section, bitmap);
				break;
			case 7:
				data = section.subarray(5);
				break;
		}
		position += length;
	}

	if (!grid || !representation || !data) {
		throw new Error('GRIB message lacks a grid, data representation or data section');
	}

	const packed = unpack(data, representation);
	const values = bitmap ? applyBitmap(packed, bitmap, grid.ni * grid.nj) : packed;
	if (values.length !== grid.ni * grid.nj) {
		throw new Error(`GRIB message holds ${values.length} values for a ${grid.ni}x${grid.nj} grid`);
	}

	return {
		...grid,
		values,
		quantum: 2 ** representation.binaryScale / 10 ** representation.decimalScale
	};
};

/** GRIB2 signed integer: a sign bit followed by the magnitude. */
const getSigned32 = (view: DataView, offset: number): number => {
	const raw = view.getUint32(offset);
	return raw & 0x80000000 ? -(raw & 0x7fffffff) : raw;
};

const getSigned16 = (view: DataView, offset: number): number => {
	const raw = view.getUint16(offset);
	return raw & 0x8000 ? -(raw & 0x7fff) : raw;
};

const MISSING_UINT32 = 0xffffffff;

const parseGridDefinition = (section: Uint8Array): GridDefinition => {
	const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
	const template = view.getUint16(12);
	// Both templates share the layout up to and including the scanning mode;
	// 3.40 only reinterprets the j increment as the Gaussian N.
	if (template !== 0 && template !== 40) {
		throw new Error(`GRIB grid template 3.${template} is not supported`);
	}
	const ni = view.getUint32(30);
	const nj = view.getUint32(34);
	if (ni === MISSING_UINT32 || nj === MISSING_UINT32) {
		throw new Error('GRIB grids with a variable number of points per row are not supported');
	}

	// Coordinates are in units of the basic angle, which is 10^-6 degrees
	// unless the message defines its own subdivision
	const basicAngle = view.getUint32(38);
	const subdivisions = view.getUint32(42);
	const unit =
		basicAngle === 0 || basicAngle === MISSING_UINT32 || subdivisions === MISSING_UINT32
			? 1e-6
			: basicAngle / subdivisions;

	const lat1 = getSigned32(view, 46) * unit;
	const lon1 = getSigned32(view, 50) * unit;
	const diRaw = view.getUint32(63);
	const di = diRaw === MISSING_UINT32 ? 360 / ni : diRaw * unit;

	const scanningMode = section[71];
	if (scanningMode & 0x20 || scanningMode & 0x10) {
		throw new Error('GRIB column-major or boustrophedonic scanning is not supported');
	}

	return {
		ni,
		nj,
		lat1,
		lon1,
		di,
		iScansNegatively: (scanningMode & 0x80) !== 0,
		jScansNegatively: (scanningMode & 0x40) === 0
	};
};

const parseDataRepresentation = (section: Uint8Array): DataRepresentation => {
	const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
	const template = view.getUint16(9);
	if (template !== 0 && template !== 2 && template !== 3) {
		throw new Error(`GRIB data representation template 5.${template} is not supported`);
	}
	const complex = template !== 0;
	return {
		numberOfValues: view.getUint32(5),
		template,
		referenceValue: view.getFloat32(11),
		binaryScale: getSigned16(view, 15),
		decimalScale: getSigned16(view, 17),
		bitsPerValue: section[19],
		missingValueManagement: complex ? section[22] : 0,
		numberOfGroups: complex ? view.getUint32(31) : 0,
		referenceGroupWidth: complex ? section[35] : 0,
		bitsPerGroupWidth: complex ? section[36] : 0,
		referenceGroupLength: complex ? view.getUint32(37) : 0,
		groupLengthIncrement: complex ? section[41] : 0,
		lastGroupLength: complex ? view.getUint32(42) : 0,
		bitsPerGroupLength: complex ? section[46] : 0,
		differencingOrder: template === 3 ? section[47] : 0,
		descriptorOctets: template === 3 ? section[48] : 0
	};
};

/**
 * The bitmap section's bits, or the previous bitmap when the section refers
 * to it (indicator 254), or none (255).
 */
const parseBitmap = (section: Uint8Array, previous: Uint8Array | undefined) => {
	const indicator = section[5];
	if (indicator === 255) return undefined;
	if (indicator === 254) return previous;
	if (indicator !== 0) {
		throw new Error(`Predefined GRIB bitmap ${indicator} is not supported`);
	}
	return section.subarray(6);
};

/** Spreads packed values over the grid: `NaN` wherever the bitmap bit is clear. */
const applyBitmap = (packed: Float32Array, bitmap: Uint8Array, count: number): Float32Array => {
	const values = new Float32Array(count);
	let next = 0;
	for (let i = 0; i < count; i++) {
		const present = bitmap[i >>> 3] & (0x80 >>> (i & 7));
		values[i] = present ? packed[next++] : NaN;
	}
	return values;
};

/** Reads big-endian bit fields of up to 53 bits from a byte array. */
class BitReader {
	private position = 0;

	constructor(private readonly bytes: Uint8Array) {}

	read(count: number): number {
		let result = 0;
		while (count > 0) {
			const byte = this.bytes[this.position >>> 3];
			if (byte === undefined) {
				throw new Error('GRIB data section ended before all values were read');
			}
			const available = 8 - (this.position & 7);
			const take = available < count ? available : count;
			const bits = (byte >>> (available - take)) & ((1 << take) - 1);
			// Multiplication rather than a shift: shifts wrap at 32 bits
			result = result * (1 << take) + bits;
			count -= take;
			this.position += take;
		}
		return result;
	}

	/** A sign bit followed by the magnitude, as GRIB stores signed fields. */
	readSigned(count: number): number {
		const negative = this.read(1) === 1;
		const magnitude = this.read(count - 1);
		return negative ? -magnitude : magnitude;
	}

	/** Skips to the next byte boundary. */
	align(): void {
		this.position = (this.position + 7) & ~7;
	}
}

const unpack = (data: Uint8Array, repr: DataRepresentation): Float32Array =>
	repr.template === 0 ? unpackSimple(data, repr) : unpackComplex(data, repr);

/** Scales packed integers to field values, as g2clib does in single precision. */
const scaleValues = (
	integers: Float64Array,
	missing: Uint8Array | undefined,
	repr: DataRepresentation
): Float32Array => {
	const binaryScale = 2 ** repr.binaryScale;
	const decimalScale = 10 ** -repr.decimalScale;
	const reference = repr.referenceValue;
	const values = new Float32Array(integers.length);
	for (let i = 0; i < integers.length; i++) {
		values[i] =
			missing && missing[i]
				? NaN
				: Math.fround(Math.fround(integers[i] * binaryScale) + reference) * decimalScale;
	}
	return values;
};

const unpackSimple = (data: Uint8Array, repr: DataRepresentation): Float32Array => {
	const count = repr.numberOfValues;
	const integers = new Float64Array(count);
	if (repr.bitsPerValue > 0) {
		const reader = new BitReader(data);
		for (let i = 0; i < count; i++) {
			integers[i] = reader.read(repr.bitsPerValue);
		}
	}
	return scaleValues(integers, undefined, repr);
};

const unpackComplex = (data: Uint8Array, repr: DataRepresentation): Float32Array => {
	const count = repr.numberOfValues;
	const groups = repr.numberOfGroups;
	const reader = new BitReader(data);

	// Spatial differencing descriptors: the first value(s) of the field and the
	// minimum that was subtracted from every difference
	let first1 = 0;
	let first2 = 0;
	let minimum = 0;
	if (repr.template === 3 && repr.descriptorOctets > 0) {
		const bits = repr.descriptorOctets * 8;
		first1 = reader.readSigned(bits);
		if (repr.differencingOrder === 2) first2 = reader.readSigned(bits);
		minimum = reader.readSigned(bits);
	}

	// Group reference values, widths and lengths, each list padded to a byte
	const references = new Float64Array(groups);
	if (repr.bitsPerValue > 0) {
		for (let g = 0; g < groups; g++) references[g] = reader.read(repr.bitsPerValue);
	}
	reader.align();

	const widths = new Int32Array(groups);
	for (let g = 0; g < groups; g++) {
		widths[g] =
			(repr.bitsPerGroupWidth > 0 ? reader.read(repr.bitsPerGroupWidth) : 0) +
			repr.referenceGroupWidth;
	}
	reader.align();

	const lengths = new Int32Array(groups);
	for (let g = 0; g < groups; g++) {
		lengths[g] =
			(repr.bitsPerGroupLength > 0 ? reader.read(repr.bitsPerGroupLength) : 0) *
				repr.groupLengthIncrement +
			repr.referenceGroupLength;
	}
	if (groups > 0) lengths[groups - 1] = repr.lastGroupLength;
	reader.align();

	let total = 0;
	for (let g = 0; g < groups; g++) total += lengths[g];
	if (total !== count) {
		throw new Error(`GRIB group lengths sum to ${total} values, the message declares ${count}`);
	}

	// The packed values: each group's values relative to its reference. With
	// missing value management, all-ones (and all-ones minus one for the
	// secondary missing value) in a group's width mark a missing point.
	const integers = new Float64Array(count);
	const management = repr.missingValueManagement;
	const missing = management > 0 ? new Uint8Array(count) : undefined;
	const referenceAllOnes = 2 ** repr.bitsPerValue - 1;
	let k = 0;
	for (let g = 0; g < groups; g++) {
		const width = widths[g];
		const length = lengths[g];
		const reference = references[g];
		if (width > 0) {
			const allOnes = 2 ** width - 1;
			for (let m = 0; m < length; m++, k++) {
				const value = reader.read(width);
				if (missing && (value === allOnes || (management === 2 && value === allOnes - 1))) {
					missing[k] = 1;
				} else {
					integers[k] = value + reference;
				}
			}
		} else {
			const groupMissing =
				missing &&
				(reference === referenceAllOnes ||
					(management === 2 && reference === referenceAllOnes - 1));
			for (let m = 0; m < length; m++, k++) {
				if (groupMissing) missing![k] = 1;
				else integers[k] = reference;
			}
		}
	}

	if (repr.template === 3) {
		undoSpatialDifferencing(integers, missing, repr.differencingOrder, first1, first2, minimum);
	}

	return scaleValues(integers, missing, repr);
};

/**
 * Reverses first or second order spatial differencing in place. Missing
 * points take no part in it: the differences run over the present values only.
 */
const undoSpatialDifferencing = (
	integers: Float64Array,
	missing: Uint8Array | undefined,
	order: number,
	first1: number,
	first2: number,
	minimum: number
): void => {
	if (order !== 1 && order !== 2) {
		throw new Error(`GRIB spatial differencing of order ${order} is not supported`);
	}

	// Indices of the values taking part, which is all of them without a bitmap
	// inside the data (the common case, handled without an index array)
	let present: Int32Array | undefined;
	let n = integers.length;
	if (missing) {
		present = new Int32Array(integers.length);
		n = 0;
		for (let i = 0; i < integers.length; i++) {
			if (!missing[i]) present[n++] = i;
		}
	}
	const at = (i: number) => (present ? present[i] : i);

	if (n === 0) return;
	integers[at(0)] = first1;
	if (order === 1) {
		for (let i = 1; i < n; i++) {
			integers[at(i)] += minimum + integers[at(i - 1)];
		}
	} else {
		if (n > 1) integers[at(1)] = first2;
		for (let i = 2; i < n; i++) {
			integers[at(i)] += minimum + 2 * integers[at(i - 1)] - integers[at(i - 2)];
		}
	}
};

/**
 * The field's values in the layout the grids of this library use: rows from
 * south to north, and for a global grid columns starting at 180° W, as the
 * `.om` files store them. A regional grid keeps its columns.
 */
export const toSouthWestOrigin = (field: Grib2Field): Float32Array => {
	const { ni, nj, values } = field;
	const out = new Float32Array(ni * nj);

	const global = Math.abs(ni * field.di - 360) < field.di;
	// Source column of output column 0: the one at 180° W, going by the
	// longitude of the message's first column
	const shift = global
		? Math.round(((((-180 - field.lon1) % 360) + 360) % 360) / field.di) % ni
		: 0;

	for (let row = 0; row < nj; row++) {
		const sourceRow = field.jScansNegatively ? nj - 1 - row : row;
		const sourceStart = sourceRow * ni;
		const outStart = row * ni;
		if (field.iScansNegatively) {
			for (let column = 0; column < ni; column++) {
				const sourceColumn = ni - 1 - ((column + shift) % ni);
				out[outStart + column] = values[sourceStart + sourceColumn];
			}
		} else {
			// A roll of the row by `shift`: two block copies
			out.set(values.subarray(sourceStart + shift, sourceStart + ni), outStart);
			out.set(values.subarray(sourceStart, sourceStart + shift), outStart + ni - shift);
		}
	}
	return out;
};
