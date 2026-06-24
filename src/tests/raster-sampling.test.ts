import { tile2lat, tile2lon } from '../utils/math';
import { describe, expect, test } from 'vitest';

// The raster worker samples pixel (i, j) of tile (x, y, z) at its CENTRE,
//   lat = tile2lat(y + (i + 0.5) / tileSize, z)
//   lon = tile2lon(x + (j + 0.5) / tileSize, z)
// These tests pin that registration. A pixel covers the geographic span
// [i, i+1) x [j, j+1); its displayed colour should come from the point it
// actually covers, i.e. its centre at (i+0.5, j+0.5). Sampling at the pixel
// corner instead reads the value half a pixel up-and-left (NW) of where the
// pixel is shown — a constant half-pixel offset that surfaces as a visible
// shift when a tile is magnified on zoom-in.
describe('raster pixel sampling registration', () => {
	const tileSize = 512;
	const z = 8;
	const x = 134;
	const y = 86;
	const i = 200;
	const j = 300;

	test('sampling at the pixel corner is half a pixel NW of the centre', () => {
		// what the worker samples for pixel (i, j)
		const sampleLat = tile2lat(y + i / tileSize, z);
		const sampleLon = tile2lon(x + j / tileSize, z);

		// where that pixel is actually displayed (its centre)
		const centreLat = tile2lat(y + (i + 0.5) / tileSize, z);
		const centreLon = tile2lon(x + (j + 0.5) / tileSize, z);

		// the sample sits NORTH and WEST (up-left) of the pixel centre
		expect(sampleLat).toBeGreaterThan(centreLat);
		expect(sampleLon).toBeLessThan(centreLon);

		// ...by exactly half a pixel
		const pixelLon = tile2lon(x + (j + 1) / tileSize, z) - tile2lon(x + j / tileSize, z);
		expect(centreLon - sampleLon).toBeCloseTo(pixelLon / 2, 10);
	});

	test('the geographic size of the offset halves with each zoom-in step', () => {
		const offsetAt = (zoom: number) => {
			const sampleLon = tile2lon(x + j / tileSize, zoom);
			const centreLon = tile2lon(x + (j + 0.5) / tileSize, zoom);
			return centreLon - sampleLon;
		};
		// zooming in one level halves the longitude span of a pixel, so the
		// fixed half-pixel offset shrinks geographically by ~2x per level
		expect(offsetAt(z) / offsetAt(z + 1)).toBeCloseTo(2, 6);
	});
});
