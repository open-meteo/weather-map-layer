import { GaussianGrid } from './gaussian';
import { GridInterface } from './interface';
import { ProjectionGrid } from './projected';
import { RegularGrid } from './regular';

import { DimensionRange, Domain } from '../types';

export class GridFactory {
	static create(data: Domain['grid'], ranges: DimensionRange[] | null = null): GridInterface {
		if (data.type === 'gaussian') {
			return new GaussianGrid(data, ranges);
		} else if (data.type === 'projected') {
			return new ProjectionGrid(data, ranges);
		} else if (data.type === 'regular') {
			return new RegularGrid(data, ranges);
		} else {
			throw new Error('Unsupported grid type');
		}
	}
}
