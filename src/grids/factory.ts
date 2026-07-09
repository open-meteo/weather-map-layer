import { GaussianGrid } from './gaussian';
import { IconGrid } from './icon';
import { IconGridAnalytical } from './icon-analytical';
import { GridInterface } from './interface';
import { ProjectionGrid } from './projected';
import { RegularGrid } from './regular';

import { DimensionRange, GridData, IconGridMode } from '../types';

// Which ICON implementation the factory builds. Switchable at runtime (e.g. from
// the maps dev UI, or per render via renderOptions.iconMode) to compare:
//   - 'table'      : embedded warp table, exact nearest, ~0.5 km accuracy (default)
//   - 'table+raster': same, but nearest-neighbour goes through a precomputed
//                     lat/lon→cell index raster (≈ regular-grid speed, but
//                     approximate and a ~2 s one-time build per grid instance)
//   - 'analytical' : no table — polynomial warp model (~33 KB, ~1.7 km accuracy)
export const gridConfig: { iconMode: IconGridMode } = { iconMode: 'table' };

// The worker builds a grid per tile; ICON construction (table decode + lattice
// unpack) costs ~10 ms and the nearest-lookup raster ~2 s, so both must be
// reused across tiles. Grids are data-independent (pure geometry), so memoize
// them by (grid definition + range + mode). The persistent instance also keeps
// its spatial-coherence caches warm between tiles.
const cache = new Map<string, GridInterface>();

export class GridFactory {
	static create(data: GridData, ranges: DimensionRange[] | null = null): GridInterface {
		const key =
			JSON.stringify(data) +
			'|' +
			JSON.stringify(ranges) +
			(data.type === 'icon' ? '|' + gridConfig.iconMode : '');
		const cached = cache.get(key);
		if (cached) return cached;
		const grid = GridFactory.build(data, ranges);
		cache.set(key, grid);
		return grid;
	}

	private static build(data: GridData, ranges: DimensionRange[] | null): GridInterface {
		switch (data.type) {
			case 'gaussian':
				return new GaussianGrid(data, ranges);
			case 'icon': {
				if (gridConfig.iconMode === 'analytical') return new IconGridAnalytical(data, ranges);
				const grid = new IconGrid(data, ranges);
				if (gridConfig.iconMode === 'table+raster') grid.buildNearestLookup();
				return grid;
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
