import { getPackageAssets } from '../assets';

import { GaussianGrid } from './gaussian';
import { IconGrid } from './icon/icon';
import { hasWarpTable, loadWarpTable } from './icon/icon-warp-tables';
import { GridInterface } from './interface';
import { getGeometry, loadGeometry } from './latband/geometry';
import { LatBandGrid } from './latband/latband';
import { ProjectionGrid } from './projected';
import { RegularGrid } from './regular';

import { DimensionRange, GridData, SharedBuffer } from '../types';

const GRID_CACHE_MAX = 32;
const gridCache = new Map<string, GridInterface>();

export class GridFactory {
	/**
	 * Loads what a grid needs from outside the bundle before it can be built:
	 * the native ICON grid fetches its warp table, a file-backed grid its cell
	 * index, the first time it is used. A no-op for every other grid type, so it
	 * is safe to await before any create().
	 */
	static async preload(data: GridData): Promise<void> {
		if (data.type === 'icon') {
			await loadWarpTable(data.iconRoot, getPackageAssets().iconWarpTables);
		}
		if (data.type === 'latband') {
			await loadGeometry(data.geometry);
		}
	}

	/** Preloaded buffers the tile workers need for this grid (see WorkerPool.share). */
	static sharedBuffers(data: GridData): SharedBuffer[] {
		if (data.type !== 'latband') return [];
		const geometry = getGeometry(data.geometry);
		return geometry ? [{ key: data.geometry, buffer: geometry }] : [];
	}

	static create(data: GridData, ranges: DimensionRange[] | null = null): GridInterface {
		// Grids are immutable after construction, but get rebuilt for every tile
		// message; construction is expensive for projected grids (trig setup).
		const key = `${JSON.stringify(data)}|${ranges?.map((r) => `${r.start}-${r.end}`).join(',') ?? ''}`;
		const cached = gridCache.get(key);
		if (cached) {
			// Re-insert to keep insertion order as LRU order
			gridCache.delete(key);
			gridCache.set(key, cached);
			return cached;
		}
		const grid = this.createUncached(data, ranges);
		gridCache.set(key, grid);
		if (gridCache.size > GRID_CACHE_MAX) {
			gridCache.delete(gridCache.keys().next().value!);
		}
		return grid;
	}

	private static createUncached(data: GridData, ranges: DimensionRange[] | null): GridInterface {
		switch (data.type) {
			case 'gaussian':
				return new GaussianGrid(data, ranges);
			case 'icon':
				// Without its table the grid would silently fall back to the uncorrected
				// geometry, ~20 km off the operational cells.
				if (!hasWarpTable(data.iconRoot)) {
					throw new Error('await GridFactory.preload(grid) before creating an icon grid');
				}
				return new IconGrid(data, ranges);
			case 'latband': {
				const geometry = getGeometry(data.geometry);
				if (!geometry) {
					throw new Error('await GridFactory.preload(grid) before creating a latband grid');
				}
				return new LatBandGrid(data, geometry, ranges);
			}
			case 'projectedFromBounds':
			case 'projectedFromProjectedOrigin':
			case 'projectedFromGeographicOrigin':
				return new ProjectionGrid(data, ranges);
			case 'regular':
				return new RegularGrid(data, ranges);
			default: {
				// This ensures exhaustiveness checking
				const _exhaustive: never = data;
				throw new Error(`Unknown grid type: ${_exhaustive}`);
			}
		}
	}
}
