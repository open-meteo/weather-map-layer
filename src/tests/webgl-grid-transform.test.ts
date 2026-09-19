import {
	createWebGLGridDescriptor,
	geographicToGrid,
	gridToGeographic,
	gridToTextureCoordinate,
	visibleWorldOffsets
} from '../webgl/grid-transform';
import { describe, expect, test } from 'vitest';

import type { GridData } from '../types';

describe('WebGL grid transforms', () => {
	test('registers regular-grid nodes at texel centers', () => {
		const descriptor = createWebGLGridDescriptor({
			type: 'regular',
			nx: 8,
			ny: 5,
			lonMin: -20,
			latMin: 40,
			dx: 0.25,
			dy: 0.5
		});
		expect(geographicToGrid(descriptor, 41.5, -18.75)).toEqual([5, 3]);
		expect(gridToTextureCoordinate(descriptor, 5, 3)).toEqual([5.5 / 8, 3.5 / 5]);
	});

	test('handles descending latitude grids without flipping data', () => {
		const descriptor = createWebGLGridDescriptor({
			type: 'regular',
			nx: 4,
			ny: 4,
			lonMin: 0,
			latMin: 70,
			dx: 1,
			dy: -2
		});
		expect(geographicToGrid(descriptor, 70, 0)).toEqual([0, -0]);
		expect(geographicToGrid(descriptor, 64, 3)).toEqual([3, 3]);
	});

	test('bridges the double-width ICON seam', () => {
		const descriptor = createWebGLGridDescriptor({
			type: 'regular',
			nx: 2879,
			ny: 2,
			lonMin: -180,
			latMin: 0,
			dx: 0.125,
			dy: 1
		});
		expect(descriptor.longitudeWrap).toBe(true);
		expect(descriptor.wrapLastCellDouble).toBe(true);
		expect(geographicToGrid(descriptor, 0, 179.875)[0]).toBeCloseTo(2878.5, 10);
		expect(geographicToGrid(descriptor, 0, -180)[0]).toBe(0);
	});

	test('wraps a descending global longitude axis', () => {
		const descriptor = createWebGLGridDescriptor({
			type: 'regular',
			nx: 1440,
			ny: 2,
			lonMin: 180,
			latMin: 0,
			dx: -0.25,
			dy: 1
		});
		expect(geographicToGrid(descriptor, 0, 179.75)[0]).toBe(1);
		expect(geographicToGrid(descriptor, 0, -180)[0]).toBe(0);
	});

	test.each([
		{
			name: 'Lambert conformal',
			grid: {
				type: 'projectedFromGeographicOrigin',
				nx: 20,
				ny: 10,
				latitude: 38.599,
				longitude: 1.334,
				dx: 2325,
				dy: 2325,
				projection: {
					name: 'LambertConformalConicProjection',
					λ0: 17,
					ϕ0: 46.244,
					ϕ1: 46.244,
					ϕ2: 46.244,
					radius: 6371229
				}
			} satisfies GridData
		},
		{
			name: 'rotated latitude/longitude',
			grid: {
				type: 'projectedFromProjectedOrigin',
				nx: 20,
				ny: 10,
				longitudeProjectionOrigin: -22.18489,
				latitudeProjectionOrigin: -5.299605,
				dx: 0.00899,
				dy: 0.00899,
				projection: {
					name: 'RotatedLatLonProjection',
					rotatedLat: 33.443381,
					rotatedLon: 86.463574
				}
			} satisfies GridData
		}
	])('round-trips $name grid nodes', ({ grid }) => {
		const descriptor = createWebGLGridDescriptor(grid);
		const [latitude, longitude] = gridToGeographic(descriptor, 7, 4);
		const [x, y] = geographicToGrid(descriptor, latitude, longitude);
		expect(x).toBeCloseTo(7, 7);
		expect(y).toBeCloseTo(4, 7);
	});

	test('returns every visible repeated world', () => {
		expect(visibleWorldOffsets([-180, -90, 180, 90], -550, 550)).toEqual([-720, -360, 0, 360, 720]);
		expect(visibleWorldOffsets([-10, 40, 20, 60], 350, 390)).toEqual([360]);
	});

	test('rejects reduced Gaussian grids explicitly', () => {
		expect(() =>
			createWebGLGridDescriptor({
				type: 'gaussian',
				nx: 6599680,
				ny: 1,
				gaussianGridLatitudeLines: 1280
			})
		).toThrow(/reduced Gaussian grids/);
	});
});
