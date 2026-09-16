import { GaussianGrid } from './gaussian';
import { GridInterface } from './interface';
import { ProjectionGrid } from './projected';
import { RegularGrid } from './regular';

import { DimensionRange, GridData } from '../types';

const GRID_CACHE_MAX = 32;
const gridCache = new Map<string, GridInterface>();

export class GridFactory {
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
