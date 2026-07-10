import { GaussianGrid } from './gaussian';
import { IconGrid } from './icon/icon';
import { IconGridAnalytical } from './icon/icon-analytical';
import { IconMeshGrid, parseIconMeshGeometry } from './icon/icon-mesh';
import { GridInterface } from './interface';
import { ProjectionGrid } from './projected';
import { RegularGrid } from './regular';

import { DimensionRange, GridData, IconGridMode, IconMeshGeometry } from '../types';

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

// Decoded icon-mesh geometry, keyed by its URL. Fetched once by preload() (it is
// a multi-MB binary, so it can't ride along in the grid definition or the
// per-tile worker message) and reused by every create() for that grid.
const geometryCache = new Map<string, IconMeshGeometry>();

export class GridFactory {
	/**
	 * Load any out-of-band data a grid type needs before it can be built. For
	 * `icon-mesh` this fetches + decodes the triangle geometry binary; it MUST be
	 * awaited before `create()` for such a grid. A no-op for every other type, so
	 * it is safe to await before any create.
	 */
	static async preload(data: GridData): Promise<void> {
		if (data.type !== 'icon-mesh' || geometryCache.has(data.geometry)) return;
		// A root-relative geometry path ('/grid-geometry/…') can't be fetched from
		// an inline (blob) worker — it has no document base to resolve against — so
		// make it absolute against the page origin. Absolute URLs pass through.
		const origin =
			typeof location !== 'undefined' && location.origin && location.origin !== 'null'
				? location.origin
				: undefined;
		const url = origin ? new URL(data.geometry, origin).href : data.geometry;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`icon-mesh geometry fetch failed (${res.status}): ${url}`);
		geometryCache.set(data.geometry, parseIconMeshGeometry(await res.arrayBuffer()));
	}

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
			case 'icon-mesh': {
				const geometry = geometryCache.get(data.geometry);
				if (!geometry)
					throw new Error('await GridFactory.preload(grid) before creating an icon-mesh grid');
				return new IconMeshGrid(data, geometry, ranges);
			}
			default: {
				// This ensures exhaustiveness checking
				const _exhaustive: never = data;
				throw new Error(`Unknown grid type: ${_exhaustive}`);
			}
		}
	}
}
