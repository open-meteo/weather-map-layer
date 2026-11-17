import { promisify } from 'node:util';
import { deflate as deflateCallback, deflateSync } from 'node:zlib';

import type { RgbaTile } from '../types';

const deflate = promisify(deflateCallback);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	CRC_TABLE[n] = c >>> 0;
}

const crc32 = (bytes: Uint8Array): number => {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
};

/** A PNG chunk: length, type, data, CRC over type + data. */
const chunk = (type: string, data: Uint8Array): Uint8Array => {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
};

/** The IHDR payload and the unfiltered scanlines of a tile, the two inputs of its PNG. */
const scanlines = (tile: RgbaTile): { ihdr: Uint8Array; raw: Uint8Array } => {
	const { width, height, rgba } = tile;
	if (rgba.length !== width * height * 4) {
		throw new Error(`Expected ${width * height * 4} RGBA bytes, got ${rgba.length}`);
	}

	const ihdr = new Uint8Array(13);
	const ihdrView = new DataView(ihdr.buffer);
	ihdrView.setUint32(0, width);
	ihdrView.setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: RGBA
	// compression, filter and interlace methods are all 0

	const stride = width * 4;
	const raw = new Uint8Array(height * (1 + stride));
	for (let row = 0; row < height; row++) {
		// Each scanline is prefixed with its filter type byte, 0 = unfiltered.
		raw.set(rgba.subarray(row * stride, (row + 1) * stride), row * (1 + stride) + 1);
	}
	return { ihdr, raw };
};

/** The file: signature, IHDR, one IDAT holding the compressed scanlines, IEND. */
const assemble = (ihdr: Uint8Array, idat: Uint8Array): Uint8Array => {
	const chunks = [
		new Uint8Array(PNG_SIGNATURE),
		chunk('IHDR', ihdr),
		chunk('IDAT', idat),
		chunk('IEND', new Uint8Array(0))
	];
	const png = new Uint8Array(chunks.reduce((length, part) => length + part.length, 0));
	let offset = 0;
	for (const part of chunks) {
		png.set(part, offset);
		offset += part.length;
	}
	return png;
};

/**
 * Encodes a tile as an 8-bit RGBA PNG. Dependency-free so the Node entry
 * stays as light as the browser one; every row uses filter type 0 (none),
 * which costs a little compression but no per-row filter search.
 */
export const encodePng = (tile: RgbaTile): Uint8Array => {
	const { ihdr, raw } = scanlines(tile);
	return assemble(ihdr, new Uint8Array(deflateSync(raw)));
};

/**
 * `encodePng` with the compression on zlib's thread pool. Synchronously, a
 * 512 px tile holds the event loop for several milliseconds, about as long
 * as its render, which the render threads were meant to keep off it.
 */
export const encodePngAsync = async (tile: RgbaTile): Promise<Uint8Array> => {
	const { ihdr, raw } = scanlines(tile);
	return assemble(ihdr, new Uint8Array(await deflate(raw)));
};
