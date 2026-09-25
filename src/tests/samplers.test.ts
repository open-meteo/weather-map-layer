import type { GridInterface } from '../grids/interface';
import { type GridPointSource, generateGridPoints } from '../utils/grid-points';
import { createSamplers } from '../utils/samplers';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader, PbfWriter } from 'pbf';
import { describe, expect, it } from 'vitest';

import type { Domain, GridData, LayerRenderData } from '../types';

// Two regular grids: a fine 11×11 one spanning [-5,5]² whose data is only valid
// in the central 5×5 block (lon/lat -2..2, the rest NaN like a reprojected
// domain's padding), and a coarse global one that has data everywhere.
const fineGridData: GridData = {
	type: 'regular',
	nx: 11,
	ny: 11,
	latMin: -5,
	lonMin: -5,
	dx: 1,
	dy: 1,
	zoom: 1
};
const globalGridData: GridData = {
	type: 'regular',
	nx: 36,
	ny: 18,
	latMin: -90,
	lonMin: -180,
	dx: 10,
	dy: 10,
	zoom: 1
};

const fullRanges = (grid: GridData) => [
	{ start: 0, end: grid.ny! },
	{ start: 0, end: grid.nx! }
];

const fineLayer = (fill: (values: Float32Array) => void, directions?: number): LayerRenderData => {
	const values = new Float32Array(121).fill(NaN);
	fill(values);
	return {
		domain: { value: 'fine', grid: fineGridData } as Domain,
		data: {
			values,
			directions: directions === undefined ? undefined : new Float32Array(121).fill(directions)
		},
		ranges: fullRanges(fineGridData)
	};
};
const globalLayer = (value: number, direction?: number): LayerRenderData => ({
	domain: { value: 'global', grid: globalGridData } as Domain,
	data: {
		values: new Float32Array(36 * 18).fill(value),
		directions: direction === undefined ? undefined : new Float32Array(36 * 18).fill(direction)
	},
	ranges: fullRanges(globalGridData)
});
const fillCentre = (values: Float32Array) => {
	for (let yy = 3; yy <= 7; yy++) for (let xx = 3; xx <= 7; xx++) values[yy * 11 + xx] = 10;
};

describe('createSamplers – values', () => {
	const { sampleValue } = createSamplers([fineLayer(fillCentre), globalLayer(0)], 'linear');

	it('returns the fine value where the fine layer has data', () => {
		expect(sampleValue(0, 0)).toBeCloseTo(10, 5);
	});

	it('falls through to the coarse layer in the fine layer’s NaN padding', () => {
		expect(sampleValue(0, 4)).toBe(0);
	});

	it('falls through to the coarse layer outside the fine grid', () => {
		expect(sampleValue(0, 30)).toBe(0);
	});
});

describe('createSamplers – vectors', () => {
	const { sampleVector } = createSamplers(
		[fineLayer(fillCentre, 0), globalLayer(10, 90)],
		'linear'
	);

	it('returns the fine vector where the fine layer has data', () => {
		const { value, direction } = sampleVector(0, 0);
		expect(value).toBeCloseTo(10, 5);
		expect(direction).toBeCloseTo(0, 5);
	});

	it('falls through to the coarse vector beyond the fine data', () => {
		const { value, direction } = sampleVector(0, 30);
		expect(value).toBeCloseTo(10, 5);
		expect(direction).toBeCloseTo(90, 5);
	});

	it('skips layers without directions', () => {
		const { sampleVector } = createSamplers([fineLayer(fillCentre), globalLayer(10, 90)], 'linear');
		expect(sampleVector(0, 0).direction).toBeCloseTo(90, 5);
	});
});

describe('generateGridPoints across seamless layers', () => {
	const decodeGrid = (sources: GridPointSource[]) => {
		const pbf = new PbfWriter();
		generateGridPoints(pbf, sources, 0, 0, 0, undefined);
		const layer = new VectorTile(new PbfReader(pbf.finish())).layers['grid'];
		const values: number[] = [];
		for (let i = 0; i < (layer?.length ?? 0); i++) {
			values.push(layer.feature(i).properties.value as number);
		}
		return values.sort((a, b) => a - b);
	};

	it('drops coarse points already covered by a finer domain', () => {
		const fineGrid = {
			getLinearInterpolatedValue: (_arr: Float32Array, lat: number, lon: number) =>
				Math.abs(lat) <= 5 && Math.abs(lon) <= 5 ? 100 : NaN,
			forEachPoint: (cb: (p: { index: number; lat: number; lon: number }) => void) => {
				cb({ index: 0, lat: 0, lon: 0 });
			}
		} as unknown as GridInterface;
		const coarseGrid = {
			getLinearInterpolatedValue: () => 50,
			forEachPoint: (cb: (p: { index: number; lat: number; lon: number }) => void) => {
				cb({ index: 0, lat: 0, lon: 0 }); // inside fine → should be masked
				cb({ index: 1, lat: 0, lon: 50 }); // outside fine → should remain
			}
		} as unknown as GridInterface;

		const values = decodeGrid([
			{ grid: fineGrid, values: new Float32Array([100]) },
			{ grid: coarseGrid, values: new Float32Array([50, 50]) }
		]);

		// Fine point (100) plus the uncovered coarse point (50); the coarse point that
		// coincides with the fine domain is masked out.
		expect(values).toEqual([50, 100]);
	});
});
