import { MESH_TEX_WIDTH, buildLatBandMesh } from '../gpu/latband-mesh';
import type { LatBandGrid } from '../grids/latband/latband';
import { describe, expect, it } from 'vitest';

const D2R = Math.PI / 180;

/**
 * A lattice of cell centres behind the two LatBandGrid members the mesh
 * builder reads: the box walk (exact box, where the real one visits whole
 * buckets) and the spacing.
 */
const latticeGrid = (
	west: number,
	south: number,
	east: number,
	north: number,
	step: number
): LatBandGrid => {
	const centres: Array<[lat: number, lon: number, cell: number]> = [];
	for (let lat = south; lat <= north + 1e-9; lat += step) {
		for (let lon = west; lon <= east + 1e-9; lon += step) centres.push([lat, lon, centres.length]);
	}
	return {
		spacing: step * D2R,
		forEachRecordInBox: (
			s: number,
			w: number,
			n: number,
			e: number,
			callback: (x: number, y: number, z: number, id: number) => void
		) => {
			for (const [lat, lon, cell] of centres) {
				const offset = (((lon - w) % 360) + 360) % 360;
				if (lat < s || lat > n || offset > e - w) continue;
				const cosLat = Math.cos(lat * D2R);
				callback(
					cosLat * Math.cos(lon * D2R),
					cosLat * Math.sin(lon * D2R),
					Math.sin(lat * D2R),
					cell
				);
			}
		}
	} as unknown as LatBandGrid;
};

const xsOf = (mesh: NonNullable<ReturnType<typeof buildLatBandMesh>>): number[] =>
	Array.from({ length: mesh.pointCount }, (_, i) => mesh.points[4 * i]);

describe('latband mesh', () => {
	it('triangulates the centres around the view, padded to texture rows', () => {
		const mesh = buildLatBandMesh(latticeGrid(0, 40, 20, 60, 0.5), [5, 45, 15, 55], 1e6)!;
		expect(mesh.wholeWorld).toBe(false);
		// A Delaunay triangulation has about two triangles per point.
		expect(mesh.triangleCount).toBeGreaterThan(1.8 * mesh.pointCount);
		expect(mesh.points.length % (4 * MESH_TEX_WIDTH)).toBe(0);
		expect(mesh.triangles.length % (3 * MESH_TEX_WIDTH)).toBe(0);
		expect(mesh.acceptRadius).toBeCloseTo(1.5 * 0.5 * D2R);
		for (let i = 0; i < mesh.pointCount; i++) {
			// The view plus its 15% margin: 1.5° each side.
			const lon = mesh.points[4 * i] * 360 - 180;
			expect(lon).toBeGreaterThanOrEqual(3.5 - 1e-4);
			expect(lon).toBeLessThanOrEqual(16.5 + 1e-4);
			expect(Number.isInteger(mesh.points[4 * i + 2])).toBe(true);
		}
		for (let i = 0; i < 3 * mesh.triangleCount; i++) {
			expect(mesh.triangles[i]).toBeLessThan(mesh.pointCount);
		}
	});

	it('thins a dense view to the point budget and widens the acceptance radius', () => {
		const grid = latticeGrid(0, 40, 20, 60, 0.25);
		const full = buildLatBandMesh(grid, [5, 45, 15, 55], 1e6)!;
		const budget = Math.ceil(full.pointCount / 4);
		const thinned = buildLatBandMesh(grid, [5, 45, 15, 55], budget)!;
		expect(thinned.pointCount).toBeLessThanOrEqual(budget);
		expect(thinned.acceptRadius).toBeCloseTo(full.acceptRadius * 2);
	});

	it('keeps a view across the antimeridian contiguous', () => {
		const mesh = buildLatBandMesh(latticeGrid(-180, -10, 179.5, 10, 0.5), [170, -5, 190, 5], 1e6)!;
		const xs = xsOf(mesh);
		// 167..193 east: one interval, not wrapped back to -180.
		expect(Math.min(...xs)).toBeGreaterThan((167 + 180) / 360 - 1e-6);
		expect(Math.max(...xs)).toBeLessThan((193 + 180) / 360 + 1e-6);
	});

	it('meshes a whole world with its seam repeated past both ends', () => {
		const mesh = buildLatBandMesh(latticeGrid(-180, -60, 179, 60, 1), [-200, -50, 200, 50], 1e6)!;
		expect(mesh.wholeWorld).toBe(true);
		expect(mesh.coverage[2] - mesh.coverage[0]).toBeCloseTo(1);
		const xs = xsOf(mesh);
		expect(Math.min(...xs)).toBeLessThan(mesh.coverage[0]);
		expect(Math.max(...xs)).toBeGreaterThan(mesh.coverage[2]);
	});

	it('needs three centres in view', () => {
		expect(buildLatBandMesh(latticeGrid(0, 0, 1, 1, 1), [50, 50, 51, 51], 1e6)).toBeUndefined();
	});
});
