import { GridFactory } from '../grids/index';
import type { GridInterface } from '../grids/interface';
import { type GridPointSource, generateGridPoints } from '../utils/grid-points';
import { sampleBlendedValue, sampleBlendedVector } from '../utils/seamless-sampling';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader, PbfWriter } from 'pbf';
import { describe, expect, it } from 'vitest';

import type { Bounds, Domain, GridData, SeamlessLayerRenderData } from '../types';

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
	covers: Coverage,
	bounds: Bounds
): GridInterface =>
	({
		getLinearInterpolatedValue: (arr: Float32Array, lat: number, lon: number) =>
			covers(lat, lon) ? (dirsRef && arr === dirsRef ? dir : speed) : NaN,
		edgeDistanceDeg: (lat: number, lon: number) =>
			Math.min(lon - bounds[0], bounds[2] - lon, lat - bounds[1], bounds[3] - lat)
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
	const grids = [
		fakeGrid(100, 0, undefined, insideFine, FINE_BOUNDS),
		fakeGrid(50, 0, undefined, everywhere, WORLD_BOUNDS)
	];
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
	const grids = [
		fakeGrid(10, 0, fineDirs, insideFine, FINE_BOUNDS),
		fakeGrid(10, 90, coarseDirs, everywhere, WORLD_BOUNDS)
	];
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

describe('blend edge distance uses edgeGrids (full domain), not the value grids', () => {
	it('fades the blend at the edgeGrid boundary even when the value grid covers everywhere', () => {
		// Value grids cover the whole world (so coverage never falls through), but the
		// edge grids describe a small FINE_BOUNDS domain. The blend must follow the
		// edge grids — this is what lets the worker use full-domain grids for the blend
		// while sampling values from viewport-cropped grids.
		const valueFine = fakeGrid(10, 0, undefined, everywhere, WORLD_BOUNDS);
		const valueCoarse = fakeGrid(0, 0, undefined, everywhere, WORLD_BOUNDS);
		const edgeFine = fakeGrid(0, 0, undefined, everywhere, FINE_BOUNDS);
		const edgeCoarse = fakeGrid(0, 0, undefined, everywhere, WORLD_BOUNDS);
		const layers = [
			fakeLayer(new Float32Array([10]), undefined, FINE_BOUNDS, 2),
			fakeLayer(new Float32Array([0]), undefined, WORLD_BOUNDS, 0)
		];
		const sample = sampleBlendedValue([valueFine, valueCoarse], layers, [edgeFine, edgeCoarse]);

		expect(sample(0, 0)).toBe(10); // deep inside the edge domain → fine value
		expect(sample(0, 9)).toBeCloseTo(5, 6); // 1° from the FINE edge, blendWidth 2 → t=0.5
	});
});

describe('sampleBlendedValue across a NULL-padded regular grid', () => {
	it('fades the blend across the real data (NaN) boundary, not the grid box', () => {
		// 11×11 grid spanning [-5,5]² with valid data only in the central 5×5 block
		// (lon/lat -2..2); the rest is NaN, like a reprojected domain's padding.
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
		const fineGrid = GridFactory.create(fineGridData);
		const globalGrid = GridFactory.create(globalGridData);

		const fineVals = new Float32Array(121).fill(NaN);
		for (let yy = 3; yy <= 7; yy++) for (let xx = 3; xx <= 7; xx++) fineVals[yy * 11 + xx] = 10;
		const globalVals = new Float32Array(36 * 18).fill(0);

		const layers: SeamlessLayerRenderData[] = [
			{
				domain: { value: 'fine', grid: fineGridData } as Domain,
				data: { values: fineVals, directions: undefined },
				ranges: [
					{ start: 0, end: 11 },
					{ start: 0, end: 11 }
				],
				domainBounds: fineGrid.getBounds(),
				blendWidthDeg: 2,
				nanFieldKey: 'test-null-padded-fine'
			},
			{
				domain: { value: 'global', grid: globalGridData } as Domain,
				data: { values: globalVals, directions: undefined },
				ranges: [
					{ start: 0, end: 18 },
					{ start: 0, end: 36 }
				],
				domainBounds: globalGrid.getBounds(),
				blendWidthDeg: 0
			}
		];
		const sample = sampleBlendedValue([fineGrid, globalGrid], layers);

		expect(sample(0, 0)).toBeCloseTo(10, 5); // deep inside the valid block → fine
		expect(sample(0, 4)).toBe(0); // NaN padding → falls through to the global 0
		// Just inside the valid block, ~1.4° from the NaN edge: blended (a box-based
		// blend would report this as deep inside → a hard 10).
		const blended = sample(0, 1.6);
		expect(blended).toBeGreaterThan(0);
		expect(blended).toBeLessThan(10);
	});
});
