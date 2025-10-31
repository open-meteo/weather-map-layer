import { GaussianGrid } from './gaussian';
import { GridInterface } from './interface';
import { ProjectionGrid } from './projected';
import { RegularGrid } from './regular';

import { DimensionRange, GridData } from '../types';

export class GridFactory {
	static create(data: GridData, ranges: DimensionRange[] | null = null): GridInterface {
		switch (data.type) {
			case 'gaussian':
				return new GaussianGrid(data, ranges);
			case 'projectedFromBounds':
			case 'projectedFromProjectedOrigin':
			case 'projectedFromGeographicOrigin':
				return new ProjectionGrid(data, ranges);
			case 'regular':
				return new RegularGrid(data, ranges);
			default:
				// This ensures exhaustiveness checking
				const _exhaustive: never = data;
				throw new Error(`Unknown grid type: ${_exhaustive}`);
		}
	}
}
