import { LUT_SIZE, buildColorLut } from '../gpu/color-lut';
import { computeGridUniforms } from '../gpu/grid-uniforms';
import { WeatherGpuLayer } from '../gpu/layer';
import { fragmentSource, shaderKey, vertexSource } from '../gpu/shader-source';
import type { ProjectionShaderData } from '../gpu/shader-source';
import { GridFactory } from '../grids/index';
import { defaultOmProtocolSettings } from '../om-protocol';
import { lat2tile, lon2tile } from '../utils/math';
import { getColorScale, makeColorSampler } from '../utils/styling';
import { describe, expect, it } from 'vitest';

import type { GridData, InterpolationMethod, RenderableColorScale } from '../types';

const INTERPOLATIONS: InterpolationMethod[] = ['nearest', 'linear', 'cubic', 'monotone'];

describe('gpu shader source', () => {
	it('assembles a fragment shader for every interpolation method', () => {
		const keys = new Set<string>();
		for (const interpolation of INTERPOLATIONS) {
			const source = fragmentSource({ interpolation });
			expect(source).toContain('#version 300 es');
			expect(source).toContain('void main()');
			// The sampler dispatches to the port of the CPU method the URL selected.
			const fn = `interp${interpolation[0].toUpperCase()}${interpolation.slice(1)}`;
			expect(source).toContain(`return ${fn}(u_values, meta(), c);`);
			keys.add(shaderKey({ interpolation }));
		}
		// One program per method: the cache key must tell them apart.
		expect(keys.size).toBe(INTERPOLATIONS.length);
	});

	it('builds the vertex shader around the map projection prelude', () => {
		// MapLibre's shaderData prelude provides projectTile, so the same body
		// renders on mercator, globe and the transition between them.
		const shaderData: ProjectionShaderData = {
			variantName: 'globe',
			vertexShaderPrelude: 'vec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }',
			define: '#define GLOBE'
		};
		const source = vertexSource(shaderData);
		expect(source).toContain(shaderData.vertexShaderPrelude);
		expect(source).toContain('#define GLOBE');
		expect(source).toContain('projectTile(vec2(pos.x + u_worldOffset, pos.y))');
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
		expect(u.nx).toBe(2879);
		expect(u.ny).toBe(1441);
		expect(u.originX).toBe(-180);
		expect(u.originY).toBe(-90);
		expect(u.lonWrap).toBe(true);
		expect(u.wrapLastCellDouble).toBe(true);
		// Mercator quad covers the whole world (lat clamped to the mercator range)
		expect(u.quad[0]).toBeCloseTo(0, 5);
		expect(u.quad[1]).toBeCloseTo(0, 5);
		expect(u.quad[2]).toBeCloseTo(1, 5);
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

	it('agrees with the CPU RegularGrid on origin, centre and bounds', () => {
		// ecmwf_ifs025: global 0.25 degree grid, full and viewport-cropped
		const grid: GridData = {
			type: 'regular',
			nx: 1440,
			ny: 721,
			lonMin: -180,
			latMin: -90,
			dx: 0.25,
			dy: 0.25
		};
		const crops = [
			null,
			[
				{ start: 100, end: 500 },
				{ start: 200, end: 900 }
			]
		];
		for (const ranges of crops) {
			const u = computeGridUniforms(grid, ranges);
			const cpu = GridFactory.create(grid, ranges);
			const [west, south, east, north] = cpu.getBounds();
			// The origin is the first data point, which is the CPU grid's west/south bound.
			expect(u.originX).toBeCloseTo(west, 9);
			expect(u.originY).toBeCloseTo(south, 9);
			// RegularGrid.getCenter(): origin + half the span.
			const centre = cpu.getCenter();
			expect(u.originX + u.dx * (u.nx / 2)).toBeCloseTo(centre.lng, 9);
			expect(u.originY + u.dy * (u.ny / 2)).toBeCloseTo(centre.lat, 9);
			// The quad is the CPU bounds in mercator space; a wrapping grid spans
			// exactly one world so adjacent copies meet.
			expect(u.quad[0]).toBeCloseTo(lon2tile(west, 0), 9);
			expect(u.quad[1]).toBeCloseTo(lat2tile(Math.min(north, 85.051129), 0), 9);
			expect(u.quad[2]).toBeCloseTo(u.lonWrap ? u.quad[0] + 1 : lon2tile(east, 0), 9);
			expect(u.quad[3]).toBeCloseTo(lat2tile(Math.max(south, -85.051129), 0), 9);
		}
	});

	it('throws for grids that are not regular', () => {
		const gaussian: GridData = {
			type: 'gaussian',
			nx: 4 * 1280 * (1280 + 9),
			ny: 1,
			gaussianGridLatitudeLines: 1280
		};
		expect(() => computeGridUniforms(gaussian, null)).toThrow(/unsupported grid type 'gaussian'/);

		// ncep_hrrr_conus
		const projected: GridData = {
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
		expect(() => computeGridUniforms(projected, null)).toThrow(
			/unsupported grid type 'projectedFromBounds'/
		);
	});
});

describe('gpu color lut', () => {
	it('spans the scale domain at the LUT resolution', () => {
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
		const lut = buildColorLut(scale, false);
		expect(lut.min).toBe(-20);
		expect(lut.max).toBe(40);
		expect(lut.data.length).toBe(LUT_SIZE * 4);
	});

	it('equals the CPU colour sampler at every texel of every colour scale', () => {
		const scales = defaultOmProtocolSettings.colorScales;
		const out: [number, number, number, number] = [0, 0, 0, 0];
		let mismatch: string | undefined;
		for (const name of Object.keys(scales)) {
			for (const dark of [false, true]) {
				for (const blend of [false, true]) {
					const scale = getColorScale(name, dark, scales);
					const lut = buildColorLut(scale, blend);
					const sampler = makeColorSampler(scale, blend);
					const step = (lut.max - lut.min) / (LUT_SIZE - 1);
					for (let i = 0; i < LUT_SIZE && !mismatch; i++) {
						const cpu = sampler(lut.min + i * step, out);
						// The tile worker writes the sampled colour into a Uint8ClampedArray
						// (ImageData) with alpha scaled to 0..255; the bake must match that byte
						// conversion, not just the sampler's floats.
						const expected = Uint8ClampedArray.of(cpu[0], cpu[1], cpu[2], 255 * cpu[3]);
						const gpu = lut.data.subarray(4 * i, 4 * i + 4);
						if (
							gpu[0] !== expected[0] ||
							gpu[1] !== expected[1] ||
							gpu[2] !== expected[2] ||
							gpu[3] !== expected[3]
						) {
							mismatch = `${name} dark=${dark} blend=${blend} texel ${i}: ${[...gpu]} vs ${[...expected]}`;
						}
					}
				}
			}
		}
		expect(mismatch).toBeUndefined();
	});
});

describe('gpu layer', () => {
	it('refuses variables that carry directions before loading anything', async () => {
		const layer = new WeatherGpuLayer();
		await expect(
			layer.setUrl(
				'om://https://example.com/data_spatial/ecmwf_ifs025/2026/09/30/0000Z/2026-09-30T0000.om?variable=wind_speed_10m'
			)
		).rejects.toThrow(/carries directions/);
	});

	it('refuses seamless composite domains', async () => {
		const layer = new WeatherGpuLayer();
		await expect(
			layer.setUrl(
				'om://https://example.com/data_spatial/dwd_icon_seamless/2026/09/30/0000Z/2026-09-30T0000.om?variable=temperature_2m'
			)
		).rejects.toThrow(/seamless domain 'dwd_icon_seamless'/);
	});
});
