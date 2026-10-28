import { buildArrowAnchors } from '../gpu/arrows';
import { LUT_SIZE, buildColorLut } from '../gpu/color-lut';
import { downsampleGrid, downsampleRegular } from '../gpu/downsample';
import { computeGridUniforms } from '../gpu/grid-uniforms';
import { updateFragmentSource, windComponentsOf } from '../gpu/particles';
import { valueTextureLayout } from '../gpu/renderer';
import { fragmentSource, latbandVertexSource, vertexSource } from '../gpu/shader-source';
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

	it('assembles the native ICON mesh shaders', () => {
		for (const interpolation of INTERPOLATIONS) {
			const source = fragmentSource({ layers: [{ gridKind: 'latband' }], interpolation });
			expect(source).toContain('latbandValue(v_cells, v_cellsAcross)');
			expect(source).not.toContain('blendedValue');
			// Nearest picks a centre, the other methods interpolate on the triangle.
			expect(source.includes('dot(v_bary, cells)')).toBe(interpolation !== 'nearest');
		}
		const vertex = latbandVertexSource({
			variantName: 'mercator',
			vertexShaderPrelude: '',
			define: ''
		});
		expect(vertex).toContain('gl_VertexID');
		expect(vertex).toContain('u_meshTriangles');
		expect(vertex).toContain('u_meshNeighbours');
	});

	it('assembles a multi-layer seamless shader', () => {
		const source = fragmentSource({
			layers: [
				{ gridKind: 'projected', projectionName: 'LambertConformalConicProjection' },
				{ gridKind: 'regular' },
				{ gridKind: 'gaussian' }
			],
			interpolation: 'linear'
		});
		expect(source).toContain('sampleValue0');
		expect(source).toContain('sampleValue1');
		expect(source).toContain('sampleValue2');
		expect(source).not.toContain('u_mix'); // temporal blend is single-layer only
	});

	it('compiles a temporal variant of the multi-layer seamless shader', () => {
		const layers: FragmentShaderSpec['layers'] = [{ gridKind: 'regular' }, { gridKind: 'regular' }];
		const still = fragmentSource({ layers, interpolation: 'linear' });
		expect(still).not.toContain('u_mix');

		const temporal = fragmentSource({ layers, interpolation: 'linear', temporal: true });
		expect(temporal).toContain('u_valuesPrev0');
		expect(temporal).toContain('u_valuesPrev1');
		expect(temporal).toContain('u_mix');
	});

	it('compiles a contour isoline variant', () => {
		const plain = fragmentSource({ layers: [{ gridKind: 'regular' }], interpolation: 'linear' });
		expect(plain).not.toContain('u_contourLevels');

		const contours = fragmentSource({
			layers: [{ gridKind: 'regular' }],
			interpolation: 'linear',
			contours: true
		});
		expect(contours).toContain('u_contourLevels');
		expect(contours).toContain('fwidth(value)');
		expect(contours).toContain('u_contourOpacity');
	});

	it('builds the vertex shader around the map projection prelude', () => {
		// MapLibre's shaderData prelude supplies projectTile, so the same body
		// renders on mercator, globe and the transition between them.
		const withPrelude = vertexSource({
			variantName: 'globe',
			vertexShaderPrelude: 'vec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }',
			define: '#define GLOBE'
		});
		expect(withPrelude).toContain('#define GLOBE');
		expect(withPrelude).toContain('projectPoint(vec2(pos.x + u_worldOffset, pos.y))');
		expect(withPrelude).toContain('return projectTile(pos);');
		expect(withPrelude).not.toContain('u_elevation');

		// Over 3D terrain the vertices lift onto the elevation map.
		const elevated = vertexSource(
			{
				variantName: 'mercator',
				vertexShaderPrelude: 'vec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }',
				define: ''
			},
			true
		);
		expect(elevated).toContain('uniform sampler2D u_elevation;');
		expect(elevated).toContain('projectTileFor3D(pos, elevationAt(');
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

describe('gpu wind particles', () => {
	it('assembles the particle update shader for plain and temporal variants', () => {
		const still = updateFragmentSource(
			{ layers: [{ gridKind: 'regular' }], interpolation: 'linear' },
			false
		);
		expect(still).toContain('blendedValue(lat, lon, u_u0)');
		expect(still).toContain('blendedValue(lat, lon, u_v0)');
		expect(still).not.toContain('u_uPrev0');

		const temporal = updateFragmentSource(
			{ layers: [{ gridKind: 'regular' }], interpolation: 'linear' },
			true
		);
		expect(temporal).toContain('uniform sampler2D u_uPrev0;');
		expect(temporal).toContain('u = mix(uPrev, u, u_mix);');
	});

	it('assembles a seamless multi-layer particle update shader', () => {
		const source = updateFragmentSource(
			{
				layers: [
					{ gridKind: 'projected', projectionName: 'RotatedLatLonProjection' },
					{ gridKind: 'regular' },
					{ gridKind: 'gaussian' }
				],
				interpolation: 'linear'
			},
			false
		);
		expect(source).toContain('blendedValue(lat, lon, u_u0, u_u1, u_u2)');
		expect(source).toContain('blendedValue(lat, lon, u_v0, u_v1, u_v2)');
	});

	it('assembles the rain-mode update shader (single scalar field)', () => {
		const source = updateFragmentSource(
			{ layers: [{ gridKind: 'regular' }], interpolation: 'linear' },
			false,
			'rain'
		);
		expect(source).toContain('uniform float u_rainRef');
		expect(source).toContain('blendedValue(lat, lon, u_u0)');
		expect(source).not.toContain('u_v0');
	});

	it('compiles the wind-advected temporal blend variant', () => {
		const plain = fragmentSource({ layers: [{ gridKind: 'regular' }], interpolation: 'linear' });
		expect(plain).not.toContain('u_windU');

		const advected = fragmentSource({
			layers: [{ gridKind: 'regular' }],
			interpolation: 'linear',
			advect: true
		});
		expect(advected).toContain('uniform sampler2D u_windU;');
		expect(advected).toContain('uniform vec2 u_advect;');
		expect(advected).toContain('lon - wu * u_advect.x');
		expect(advected).toContain('lon + wu * u_advect.y');

		// Multi-layer (seamless) draws never compile the advected path.
		const multi = fragmentSource({
			layers: [{ gridKind: 'regular' }, { gridKind: 'regular' }],
			interpolation: 'linear',
			advect: true
		});
		expect(multi).not.toContain('u_windU');
	});

	it('derives eastward/northward flow components from speed + direction', () => {
		const values = new Float32Array([10, 5, NaN, 4]);
		// direction = where the wind comes FROM: 0° is a northerly (flows south).
		const directions = new Float32Array([0, 270, 90, NaN]);
		const { u, v } = windComponentsOf(values, directions);
		expect(u[0]).toBeCloseTo(0, 5);
		expect(v[0]).toBeCloseTo(-10, 5);
		// A westerly flows east: +u, no v.
		expect(u[1]).toBeCloseTo(5, 5);
		expect(v[1]).toBeCloseTo(0, 5);
		expect(u[2]).toBeNaN();
		expect(v[3]).toBeNaN();
		// Cached per source-array identity.
		expect(windComponentsOf(values, directions).u).toBe(u);
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

describe('gpu arrow anchors', () => {
	it('keeps anchors on both sides of the antimeridian for a crossing clip box', () => {
		// west past east: the box runs from 170°E over the antimeridian to 170°W
		const anchors = buildArrowAnchors(
			{ minX: 0.9, maxX: 1.1, minY: 0.45, maxY: 0.55 },
			2,
			50,
			[170, -10, -170, 10]
		);
		let east = 0;
		let west = 0;
		for (let i = 0; i < anchors.count; i++) {
			const lon = anchors.positions[i * 2] * 360 - 180;
			const lat =
				(Math.atan(Math.sinh(Math.PI * (1 - 2 * anchors.positions[i * 2 + 1]))) * 180) / Math.PI;
			expect(Math.abs(lat)).toBeLessThanOrEqual(10);
			if (lon >= 170) east++;
			else if (lon <= -170) west++;
			else throw new Error(`anchor outside the clip box at ${lon}`);
		}
		expect(east).toBeGreaterThan(0);
		expect(west).toBeGreaterThan(0);
	});
});

describe('gpu contour downsampling', () => {
	it('box-averages NaN-aware blocks aligned by the skip offsets', () => {
		// 5 x 4 grid, factor 2, one column skipped: 2 x 2 blocks starting at column 1
		const nx = 5;
		const ny = 4;
		const values = new Float32Array(nx * ny);
		for (let i = 0; i < values.length; i++) values[i] = i;
		values[1 * nx + 1] = NaN;
		const ds = downsampleRegular(values, nx, ny, 2, 1, 0);
		expect(ds).toBeDefined();
		expect(ds!.nx).toBe(2);
		expect(ds!.ny).toBe(2);
		// block (0,0) holds cells 1, 2, NaN, 7: the mean of the finite ones
		expect(ds!.values[0]).toBeCloseTo((1 + 2 + 7) / 3, 5);
		// block (1,0) holds cells 3, 4, 8, 9
		expect(ds!.values[1]).toBeCloseTo(6, 5);
		// cached per source array, factor and alignment
		expect(downsampleRegular(values, nx, ny, 2, 1, 0)).toBe(ds);
		expect(downsampleRegular(values, nx, ny, 2, 0, 0)).not.toBe(ds);
		// too few blocks for an isoline
		expect(downsampleRegular(values, nx, ny, 4)).toBeUndefined();
	});
});

describe('gpu particle field downsampling', () => {
	it('builds the coarse lattice on the same axes, anchored to the uncropped grid', () => {
		const grid: GridData = {
			type: 'regular',
			nx: 100,
			ny: 50,
			lonMin: 0,
			latMin: 0,
			dx: 0.5,
			dy: 0.5
		};
		const full = computeGridUniforms(grid, null);
		const g = computeGridUniforms(grid, [
			{ start: 10, end: 40 },
			{ start: 21, end: 81 }
		]);
		// a field equal to the crop's column index
		const values = new Float32Array(g.nx * g.ny);
		for (let i = 0; i < values.length; i++) values[i] = i % g.nx;

		const ds = downsampleGrid(values, g, 4, [full.originX, full.originY]);
		expect(ds).toBeDefined();
		// blocks start at full-grid column 24 / row 12: 3 and 2 cells into the crop
		expect(ds!.gridUniforms.nx).toBe(Math.floor((60 - 3) / 4));
		expect(ds!.gridUniforms.ny).toBe(Math.floor((30 - 2) / 4));
		expect(ds!.values[0]).toBeCloseTo((3 + 4 + 5 + 6) / 4, 5);
		// coarse cell centres: the mean of the block's points (lon 12..13.5, lat 6..7.5)
		expect(ds!.gridUniforms.originX).toBeCloseTo(12.75, 9);
		expect(ds!.gridUniforms.originY).toBeCloseTo(6.75, 9);
		expect(ds!.gridUniforms.dx).toBe(2);
		expect(ds!.gridUniforms.dy).toBe(2);
		expect(ds!.gridUniforms.lonWrap).toBe(false);
		// the same copy every frame, so its texture is reused
		expect(downsampleGrid(values, g, 4, [full.originX, full.originY])!.values).toBe(ds!.values);
		// a crop too small to coarsen
		expect(downsampleGrid(values, g, 32, [full.originX, full.originY])).toBeUndefined();
	});

	it('keeps the double-width seam only where the blocks leave two steps of the circle', () => {
		const wrapGrid = (nx: number): GridData => ({
			type: 'regular',
			nx,
			ny: 10,
			lonMin: -180,
			latMin: -9,
			dx: 2,
			dy: 2
		});
		// stored one point short of the seam (ICON-style): the gap stays two steps
		const short = computeGridUniforms(wrapGrid(179), null);
		expect(short.wrapLastCellDouble).toBe(true);
		const shortDs = downsampleGrid(new Float32Array(179 * 10), short, 4);
		expect(shortDs!.gridUniforms.nx).toBe(44);
		expect(shortDs!.gridUniforms.originX).toBe(-177);
		expect(shortDs!.gridUniforms.lonWrap).toBe(true);
		expect(shortDs!.gridUniforms.wrapLastCellDouble).toBe(true);

		// a full circle (GFS-style): the coarse seam is a single step
		const circle = computeGridUniforms(wrapGrid(180), null);
		expect(circle.wrapLastCellDouble).toBe(false);
		const circleDs = downsampleGrid(new Float32Array(180 * 10), circle, 4);
		expect(circleDs!.gridUniforms.nx).toBe(45);
		expect(circleDs!.gridUniforms.lonWrap).toBe(true);
		expect(circleDs!.gridUniforms.wrapLastCellDouble).toBe(false);
	});
});

describe('gpu value texture layout', () => {
	it('keeps grids within MAX_TEXTURE_SIZE as one texel row per grid row', () => {
		expect(valueTextureLayout(2879, 1441, 4096)).toEqual({
			width: 2879,
			height: 1441,
			packed: false
		});
	});

	it('packs grids exceeding MAX_TEXTURE_SIZE row-major into maxSize-wide rows', () => {
		// meteofrance_wave at a world view on a 4096-texel GPU
		expect(valueTextureLayout(4320, 2041, 4096)).toEqual({
			width: 4096,
			height: Math.ceil((4320 * 2041) / 4096),
			packed: true
		});
		// a tall grid packs too
		expect(valueTextureLayout(1796, 2321, 2048)?.packed).toBe(true);
	});

	it('gives up when even the packed texture is too tall', () => {
		expect(valueTextureLayout(2879, 1441, 1024)).toBeUndefined();
	});

	it('unpacks through the GridMeta pack width in the shader', () => {
		const source = fragmentSource({ layers: [{ gridKind: 'regular' }], interpolation: 'linear' });
		expect(source).toContain('uniform int u_pack0;');
		expect(source).toContain('m.pack = u_pack0;');
	});
});
