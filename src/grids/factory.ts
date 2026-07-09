import { GaussianGrid } from './gaussian';
import { IconGrid } from './icon/icon';
import { IconGridAnalytical } from './icon/icon-analytical';
import { GridInterface } from './interface';
import { ProjectionGrid } from './projected';
import { RegularGrid } from './regular';

import { DimensionRange, GridData, IconGridMode } from '../types';

// Which ICON implementation the factory builds. Switchable at runtime (e.g. from
// the maps dev UI, or per render via renderOptions.iconMode) to compare:
//   - 'table'      : embedded warp table, exact NATIVE triangular cells,
//                    ~0.5 km accuracy (default — this is the real renderer)
//   - 'analytical' : no table — polynomial warp model (~33 KB, ~1.7 km accuracy),
//                    native cells but much slower per call (see icon-analytical.ts)
export const gridConfig: { iconMode: IconGridMode } = { iconMode: 'table' };

// The worker builds a grid per tile; ICON construction (table decode + lattice
// unpack) costs ~10 ms, so grids are reused across tiles. They are data-
// independent (pure geometry), so memoize them by (grid definition + range +
// mode). The persistent instance also keeps its spatial-coherence caches warm.
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
				return new IconGrid(data, ranges);
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
