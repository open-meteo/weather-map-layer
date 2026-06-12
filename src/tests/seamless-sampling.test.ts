import type { GridInterface } from '../grids/interface';
import { type GridPointSource, generateGridPoints } from '../utils/grid-points';
import { sampleBlendedValue, sampleBlendedVector } from '../utils/seamless-sampling';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { describe, expect, it } from 'vitest';

import type { Bounds, Domain, SeamlessLayerRenderData } from '../types';

// --- Test doubles -----------------------------------------------------------

type Coverage = (lat: number, lon: number) => boolean;

/**
 * Minimal GridInterface returning `speed` for the values array and `dir` for the
 * directions array, or NaN where `covers` is false (point outside the domain).
 */
const fakeGrid = (
	speed: number,
	dir: number,
	dirsRef: Float32Array | undefined,
	covers: Coverage
): GridInterface =>
	({
		getLinearInterpolatedValue: (arr: Float32Array, lat: number, lon: number) =>
			covers(lat, lon) ? (dirsRef && arr === dirsRef ? dir : speed) : NaN
	}) as unknown as GridInterface;

const fakeLayer = (
	values: Float32Array,
	directions: Float32Array | undefined,
	domainBounds: Bounds,
	blendWidthDeg: number
): SeamlessLayerRenderData =>
	({
		domain: {} as Domain,
		data: { values, directions },
		ranges: [],
		domainBounds,
		blendWidthDeg
	}) as SeamlessLayerRenderData;

const FINE_BOUNDS: Bounds = [-10, -10, 10, 10];
const WORLD_BOUNDS: Bounds = [-180, -90, 180, 90];
const insideFine: Coverage = (lat, lon) => Math.abs(lat) <= 10 && Math.abs(lon) <= 10;
const everywhere: Coverage = () => true;

// ---------------------------------------------------------------------------

describe('sampleBlendedValue', () => {
	const fineVals = new Float32Array([100]);
	const coarseVals = new Float32Array([50]);
	const grids = [fakeGrid(100, 0, undefined, insideFine), fakeGrid(50, 0, undefined, everywhere)];
	const layers = [
		fakeLayer(fineVals, undefined, FINE_BOUNDS, 2),
		fakeLayer(coarseVals, undefined, WORLD_BOUNDS, 0)
	];
	const sample = sampleBlendedValue(grids, layers);

	it('returns the fine value deep inside the fine domain', () => {
		expect(sample(0, 0)).toBe(100);
	});

	it('falls through to the coarse domain beyond the fine footprint (fluent)', () => {
		// Previously the vector path only used the finest layer, so this point had no data.
		expect(sample(0, 30)).toBe(50);
	});

	it('smooth-step blends across the edge zone', () => {
		// At lon 9 the nearest edge distance is (10-9)/2 = 0.5 → smooth-step weight 0.5.
		expect(sample(0, 9)).toBeCloseTo(75, 6);
	});
});

describe('sampleBlendedVector', () => {
	const fineVals = new Float32Array([10]);
	const fineDirs = new Float32Array([0]); // north
	const coarseVals = new Float32Array([10]);
	const coarseDirs = new Float32Array([90]); // east
	const grids = [fakeGrid(10, 0, fineDirs, insideFine), fakeGrid(10, 90, coarseDirs, everywhere)];
	const layers = [
		fakeLayer(fineVals, fineDirs, FINE_BOUNDS, 2),
		fakeLayer(coarseVals, coarseDirs, WORLD_BOUNDS, 0)
	];
	const sample = sampleBlendedVector(grids, layers);

	it('returns the fine vector deep inside the fine domain', () => {
		const { value, direction } = sample(0, 0);
		expect(value).toBeCloseTo(10, 6);
		expect(direction).toBeCloseTo(0, 6);
	});

	it('falls through to the coarse vector beyond the fine footprint', () => {
		const { value, direction } = sample(0, 30);
		expect(value).toBeCloseTo(10, 6);
		expect(direction).toBeCloseTo(90, 6);
	});

	it('blends direction through component space across the edge zone', () => {
		// Edge weight 0.5: U = 5, V = 5 → 45° bearing, magnitude √50.
		const { value, direction } = sample(0, 9);
		expect(direction).toBeCloseTo(45, 6);
		expect(value).toBeCloseTo(Math.hypot(5, 5), 6);
	});
});

describe('generateGridPoints across seamless layers', () => {
	const decodeGrid = (sources: GridPointSource[]) => {
		const pbf = new Pbf();
		generateGridPoints(pbf, sources, 0, 0, 0, undefined);
		const layer = new VectorTile(new Pbf(pbf.finish())).layers['grid'];
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
