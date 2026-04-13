import {
	createClippingTester,
	resolveClippingOptions,
	sharedPolygonsPolygonCount,
	sharedPolygonsRingCount
} from '../utils/clipping';
import { describe, expect, test } from 'vitest';

describe('resolveClippingOptions - bounds computation', () => {
	test('non-crossing polygon produces standard bounds', () => {
		const result = resolveClippingOptions({
			geojson: {
				type: 'Feature',
				geometry: {
					type: 'Polygon',
					coordinates: [
						[
							[10, 50],
							[20, 50],
							[20, 60],
							[10, 60],
							[10, 50]
						]
					]
				}
			}
		});
		expect(result?.bounds).toEqual([10, 50, 20, 60]);
	});

	test('explicit bounds are preserved when polygons are also provided', () => {
		const result = resolveClippingOptions({
			bounds: [0, 0, 10, 10],
			geojson: {
				type: 'Feature',
				geometry: {
					type: 'Polygon',
					coordinates: [
						[
							[170, 50],
							[175, 50],
							[-175, 50],
							[-170, 50],
							[170, 50]
						]
					]
				}
			}
		});
		expect(result?.bounds).toEqual([0, 0, 10, 10]);
	});

	test('global-spanning polygon produces full globe bounds', () => {
		// A polygon that wraps entirely around the globe
		const result = resolveClippingOptions({
			geojson: {
				type: 'Feature',
				geometry: {
					type: 'Polygon',
					coordinates: [
						[
							[-180, -60],
							[-90, -60],
							[0, -60],
							[90, -60],
							[180, -60],
							[180, 60],
							[90, 60],
							[0, 60],
							[-90, 60],
							[-180, 60],
							[-180, -60]
						]
					]
				}
			}
		});
		expect(result?.bounds).toBeDefined();
		const [minLon, minLat, maxLon, maxLat] = result!.bounds!;
		expect(minLon).toBe(-180);
		expect(maxLon).toBe(180);
		expect(minLat).toBe(-60);
		expect(maxLat).toBe(60);
	});

	test('undefined options returns undefined', () => {
		expect(resolveClippingOptions(undefined)).toBeUndefined();
	});
});

describe('resolveClippingOptions - polygon structure', () => {
	test('Polygon with hole produces 1 polygon with 2 rings', () => {
		const result = resolveClippingOptions({
			geojson: {
				type: 'Feature',
				geometry: {
					type: 'Polygon',
					coordinates: [
						[
							[0, 0],
							[10, 0],
							[10, 10],
							[0, 10],
							[0, 0]
						],
						[
							[2, 2],
							[8, 2],
							[8, 8],
							[2, 8],
							[2, 2]
						]
					]
				}
			}
		});
		const sp = result!.polygons!;
		expect(sharedPolygonsPolygonCount(sp)).toBe(1);
		expect(sharedPolygonsRingCount(sp)).toBe(2);
	});

	test('MultiPolygon produces separate polygon groups', () => {
		const result = resolveClippingOptions({
			geojson: {
				type: 'Feature',
				geometry: {
					type: 'MultiPolygon',
					coordinates: [
						[
							[
								[0, 0],
								[5, 0],
								[5, 5],
								[0, 5],
								[0, 0]
							]
						],
						[
							[
								[20, 20],
								[30, 20],
								[30, 30],
								[20, 30],
								[20, 20]
							],
							[
								[22, 22],
								[28, 22],
								[28, 28],
								[22, 28],
								[22, 22]
							]
						]
					]
				}
			}
		});
		const sp = result!.polygons!;
		expect(sharedPolygonsPolygonCount(sp)).toBe(2);
		expect(sharedPolygonsRingCount(sp)).toBe(3);
	});
});

describe('createClippingTester - polygon holes', () => {
	test('point inside hole is excluded', () => {
		const resolved = resolveClippingOptions({
			geojson: {
				type: 'Feature',
				geometry: {
					type: 'Polygon',
					coordinates: [
						[
							[0, 0],
							[10, 0],
							[10, 10],
							[0, 10],
							[0, 0]
						],
						[
							[2, 2],
							[8, 2],
							[8, 8],
							[2, 8],
							[2, 2]
						]
					]
				}
			}
		});
		const tester = createClippingTester(resolved)!;
		expect(tester).toBeDefined();

		// Inside outer ring but inside hole → excluded
		expect(tester(5, 5)).toBe(false);
		// Inside outer ring but outside hole → included
		expect(tester(1, 1)).toBe(true);
		// Outside outer ring → excluded
		expect(tester(15, 15)).toBe(false);
	});

	test('MultiPolygon with hole: point in hole excluded, other polygon included', () => {
		const resolved = resolveClippingOptions({
			geojson: {
				type: 'Feature',
				geometry: {
					type: 'MultiPolygon',
					coordinates: [
						[
							[
								[0, 0],
								[10, 0],
								[10, 10],
								[0, 10],
								[0, 0]
							],
							[
								[2, 2],
								[8, 2],
								[8, 8],
								[2, 8],
								[2, 2]
							]
						],
						[
							[
								[20, 20],
								[30, 20],
								[30, 30],
								[20, 30],
								[20, 20]
							]
						]
					]
				}
			}
		});
		const tester = createClippingTester(resolved)!;

		// In hole of first polygon
		expect(tester(5, 5)).toBe(false);
		// In solid part of first polygon
		expect(tester(1, 1)).toBe(true);
		// In second polygon
		expect(tester(25, 25)).toBe(true);
		// Outside both
		expect(tester(15, 15)).toBe(false);
	});
});
