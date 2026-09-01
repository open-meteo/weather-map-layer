import { LUT_SIZE, buildColorLut } from '../gpu/color-lut';
import { computeGridUniforms } from '../gpu/grid-uniforms';
import { fragmentSource, vertexSource } from '../gpu/shader-source';
import type { FragmentShaderSpec } from '../gpu/shader-source';
import { getColor } from '../utils/styling';
import { describe, expect, it } from 'vitest';

import type { GridData, InterpolationMethod, RenderableColorScale } from '../types';

const INTERPOLATIONS: InterpolationMethod[] = ['nearest', 'linear', 'cubic', 'monotone'];
const PROJECTIONS: NonNullable<FragmentShaderSpec['layers'][number]['projectionName']>[] = [
	'StereographicProjection',
	'RotatedLatLonProjection',
	'LambertConformalConicProjection',
	'LambertAzimuthalEqualAreaProjection'
];

describe('gpu shader source', () => {
	it('assembles a fragment shader for every grid/interpolation variant', () => {
		for (const interpolation of INTERPOLATIONS) {
			const regular = fragmentSource({ layers: [{ gridKind: 'regular' }], interpolation });
			expect(regular).toContain('void main()');
			expect(regular).toContain('#version 300 es');

			const gaussian = fragmentSource({ layers: [{ gridKind: 'gaussian' }], interpolation });
			expect(gaussian).toContain('gaussSample');

			for (const projectionName of PROJECTIONS) {
				const projected = fragmentSource({
					layers: [{ gridKind: 'projected', projectionName }],
					interpolation
				});
				expect(projected).toContain('void main()');
				expect(projected).toContain('projForward');
			}
		}
	});

	it('assembles a multi-layer seamless shader with edge blending', () => {
		const source = fragmentSource({
			layers: [
				{ gridKind: 'projected', projectionName: 'LambertConformalConicProjection', blends: true },
				{ gridKind: 'regular', blends: true, hasNanField: true },
				{ gridKind: 'gaussian' }
			],
			interpolation: 'linear'
		});
		expect(source).toContain('sampleValue0');
		expect(source).toContain('sampleValue1');
		expect(source).toContain('sampleValue2');
		expect(source).toContain('edgeWeight0');
		expect(source).toContain('edgeWeight1');
		expect(source).toContain('u_nan1'); // NaN-distance refinement only on layer 1
		expect(source).not.toContain('u_nan0');
		expect(source).not.toContain('u_mix'); // temporal blend is single-layer only
	});

	it('builds the vertex shader around the map projection prelude', () => {
		const plain = vertexSource();
		expect(plain).toContain('u_matrix');
		expect(plain).toContain('projectTile');

		// MapLibre's shaderData prelude replaces the built-in projectTile, so the
		// same body renders on mercator, globe and the transition between them.
		const withPrelude = vertexSource({
			variantName: 'globe',
			vertexShaderPrelude: 'vec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }',
			define: '#define GLOBE'
		});
		expect(withPrelude).toContain('#define GLOBE');
		expect(withPrelude).toContain('projectTile(vec2(pos.x + u_worldOffset, pos.y))');
		expect(withPrelude).not.toContain('u_matrix');
	});

	it('rejects unknown projections', () => {
		expect(() =>
			fragmentSource({
				layers: [{ gridKind: 'projected', projectionName: undefined }],
				interpolation: 'linear'
			})
		).toThrow(/unsupported projection/);
	});
});

describe('gpu grid uniforms', () => {
	it('mirrors the RegularGrid constructor for a global ICON-style grid', () => {
		// dwd_icon: global 0.125 degree grid stored one point short of the seam
		const grid: GridData = {
			type: 'regular',
			nx: 2879,
			ny: 1441,
			lonMin: -180,
			latMin: -90,
			dx: 0.125,
			dy: 0.125
		};
		const u = computeGridUniforms(grid, null);
		expect(u.gridKind).toBe('regular');
		expect(u.nx).toBe(2879);
		expect(u.ny).toBe(1441);
		expect(u.originX).toBe(-180);
		expect(u.originY).toBe(-90);
		expect(u.lonWrap).toBe(true);
		expect(u.wrapLastCellDouble).toBe(true);
		// Mercator quad covers the whole world (lat clamped to the mercator range)
		expect(u.quad[0]).toBeCloseTo(0, 5);
		expect(u.quad[1]).toBeCloseTo(0, 5);
		expect(u.quad[3]).toBeCloseTo(1, 5);
	});

	it('applies dimension ranges like the CPU grid', () => {
		const grid: GridData = {
			type: 'regular',
			nx: 100,
			ny: 50,
			lonMin: 0,
			latMin: 0,
			dx: 0.5,
			dy: 0.5
		};
		const u = computeGridUniforms(grid, [
			{ start: 10, end: 40 },
			{ start: 20, end: 80 }
		]);
		expect(u.nx).toBe(60);
		expect(u.ny).toBe(30);
		expect(u.originX).toBe(10); // 0 + 0.5 * 20
		expect(u.originY).toBe(5); // 0 + 0.5 * 10
		expect(u.lonWrap).toBe(false);
	});

	it('precomputes finite projection constants for an LCC grid', () => {
		// ncep_hrrr_conus
		const grid: GridData = {
			type: 'projectedFromBounds',
			nx: 1799,
			ny: 1059,
			latitude: [21.138, 47.8424],
			longitude: [-122.72, -60.918],
			projection: {
				λ0: -97.5,
				ϕ0: 0,
				ϕ1: 38.5,
				ϕ2: 38.5,
				name: 'LambertConformalConicProjection'
			}
		};
		const u = computeGridUniforms(grid, null);
		expect(u.gridKind).toBe('projected');
		expect(u.projectionName).toBe('LambertConformalConicProjection');
		for (const value of [...u.projA, ...u.projB, u.originX, u.originY, u.dx, u.dy]) {
			expect(Number.isFinite(value)).toBe(true);
		}
		expect(u.dx).toBeGreaterThan(0);
	});

	it('packs gaussian grids into a fixed-width texture', () => {
		// O1280-style reduced gaussian grid (ECMWF IFS HRES)
		const latitudeLines = 1280;
		const count = 4 * latitudeLines * (latitudeLines + 9);
		const grid: GridData = {
			type: 'gaussian',
			nx: count,
			ny: 1,
			gaussianGridLatitudeLines: latitudeLines
		};
		const u = computeGridUniforms(grid, null);
		expect(u.gridKind).toBe('gaussian');
		expect(u.gauss[0]).toBe(latitudeLines);
		expect(u.gauss[1]).toBe(0); // nxStart
		expect(u.nx * u.ny).toBeGreaterThanOrEqual(count);
		expect(u.gauss[3]).toBe(u.nx * u.ny); // texel count guard

		// Partial reads shift indices by nxStart, like the GaussianGrid ctor
		const partial = computeGridUniforms(grid, [
			{ start: 0, end: 1 },
			{ start: 1000, end: 501000 }
		]);
		expect(partial.gauss[1]).toBe(1000);
		expect(partial.nx * partial.ny).toBeGreaterThanOrEqual(500000);
	});
});

describe('gpu color lut', () => {
	const scale: RenderableColorScale = {
		type: 'breakpoint',
		unit: '°C',
		breakpoints: [-20, 0, 20, 40],
		colors: [
			[0, 0, 255, 1],
			[0, 255, 0, 1],
			[255, 255, 0, 1],
			[255, 0, 0, 1]
		]
	};

	it('bakes the exact CPU colours at the LUT knots', () => {
		const lut = buildColorLut(scale, false);
		expect(lut.min).toBe(-20);
		expect(lut.max).toBe(40);
		expect(lut.data.length).toBe(LUT_SIZE * 4);

		// First and last texel match the CPU sampler at the domain ends
		const first = getColor(scale, lut.min);
		expect([lut.data[0], lut.data[1], lut.data[2]]).toEqual([first[0], first[1], first[2]]);
		const lastIndex = (LUT_SIZE - 1) * 4;
		const last = getColor(scale, lut.max);
		expect([lut.data[lastIndex], lut.data[lastIndex + 1], lut.data[lastIndex + 2]]).toEqual([
			last[0],
			last[1],
			last[2]
		]);
	});

	it('matches the CPU sampler across the whole domain', () => {
		const lut = buildColorLut(scale, false);
		const step = (lut.max - lut.min) / (LUT_SIZE - 1);
		for (let i = 0; i < LUT_SIZE; i += 37) {
			const value = lut.min + i * step;
			const expected = getColor(scale, value);
			expect(lut.data[4 * i]).toBe(expected[0]);
			expect(lut.data[4 * i + 1]).toBe(expected[1]);
			expect(lut.data[4 * i + 2]).toBe(expected[2]);
			expect(lut.data[4 * i + 3]).toBe(Math.round(255 * expected[3]));
		}
	});
});
