import { deflateSync } from 'node:zlib';

import type { RgbaTile } from '../types';

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

/**
 * Encodes a tile as an 8-bit RGBA PNG. Dependency-free so the Node entry
 * stays as light as the browser one; every row uses filter type 0 (none),
 * which costs a little compression but no per-row filter search.
 */
export const encodePng = (tile: RgbaTile): Uint8Array => {
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

	const chunks = [
		new Uint8Array(PNG_SIGNATURE),
		chunk('IHDR', ihdr),
		chunk('IDAT', new Uint8Array(deflateSync(raw))),
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
