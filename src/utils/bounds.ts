import { bboxToTile, tileToBBOX } from '@mapbox/tilebelt';

import { Bounds } from '../types';

export let currentBounds: Bounds | undefined = undefined;

export const updateCurrentBounds = (bounds: Bounds) => {
	const bbox = tileToBBOX(bboxToTile([bounds[0], bounds[1], bounds[2], bounds[3]]));
	currentBounds = [bbox[0], bbox[1], bbox[2], bbox[3]];
};

export const boundsIncluded = (innerBounds: Bounds, outerBounds: Bounds): boolean => {
	const [inMinX, inMinY, inMaxX, inMaxY] = innerBounds;
	const [outMinX, outMinY, outMaxX, outMaxY] = outerBounds;

	return inMinX >= outMinX && inMinY >= outMinY && inMaxX <= outMaxX && inMaxY <= outMaxY;
};
