import { resolveClippingOptions } from '../utils/clipping';
import type { ResolvedClippingOptions } from '../utils/clipping';
import type { VectorSampler } from '../utils/samplers';
import { generateWindPoints } from '../utils/wind-points';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader, PbfWriter } from 'pbf';
import { describe, expect, it } from 'vitest';

// Tile z2/1/1 spans 90°W..0° and the equator..66.5°N
const decode = (
	sampleVector: VectorSampler,
	points: number,
	z = 2,
	clipping?: ResolvedClippingOptions
): { type: number; properties: Record<string, unknown> }[] => {
	const pbf = new PbfWriter();
	generateWindPoints(pbf, sampleVector, z === 2 ? 1 : 0, z === 2 ? 1 : 0, z, clipping, points);
	const layer = new VectorTile(new PbfReader(pbf.finish())).layers['wind-points'];
	const features = [];
	for (let i = 0; i < (layer?.length ?? 0); i++) {
		const feature = layer.feature(i);
		features.push({ type: feature.type, properties: feature.properties });
	}
	return features;
};

describe('generateWindPoints', () => {
	it('emits one point per lattice cell with the sampled speed and direction', () => {
		const features = decode(() => ({ value: 7.5, direction: 225 }), 4);
		expect(features).toHaveLength(16);
		for (const feature of features) {
			expect(feature.type).toBe(1);
			expect(feature.properties.value).toBe(7.5);
			// Degrees as sampled (where the flow comes from): the host's rotation
			// expression adds the 180° for arrows, a barb's staff points upwind
			expect(feature.properties.direction).toBe(225);
			expect(typeof feature.properties.latitude).toBe('number');
		}
	});

	it('skips cells without data', () => {
		let calls = 0;
		const features = decode(() => ({ value: calls++ % 2 ? NaN : 3, direction: 90 }), 4);
		expect(features).toHaveLength(8);
	});

	it('densifies the oversized world tiles', () => {
		const sampler: VectorSampler = () => ({ value: 1, direction: 0 });
		expect(decode(sampler, 4, 0)).toHaveLength(64);
		expect(decode(sampler, 4, 1)).toHaveLength(36);
	});

	it('drops points outside the clip polygons', () => {
		// Covers the tile's three western columns (90°W, 67.5°W, 45°W), not 22.5°W
		const clipping = resolveClippingOptions({
			geojson: {
				type: 'Polygon',
				coordinates: [
					[
						[-180, -1],
						[-40, -1],
						[-40, 85],
						[-180, 85],
						[-180, -1]
					]
				]
			}
		});
		const features = decode(() => ({ value: 1, direction: 0 }), 4, 2, clipping);
		expect(features).toHaveLength(12);
	});
});
