import { bboxToTile, tileToBBOX } from '@mapbox/tilebelt';
import { LngLatBounds } from 'maplibre-gl';

import { Bounds } from '../types';

export let currentBounds: Bounds | undefined = undefined;

export const updateCurrentBounds = (bounds: LngLatBounds) => {
	const [minLng, minLat] = bounds.getSouthWest().toArray();
	const [maxLng, maxLat] = bounds.getNorthEast().toArray();

	const bbox = tileToBBOX(bboxToTile([minLng, minLat, maxLng, maxLat]));

	currentBounds = [bbox[0], bbox[1], bbox[2], bbox[3]];
};

export const boundsIncluded = (innerBounds: Bounds, outerBounds: Bounds): boolean => {
	const [inMinX, inMinY, inMaxX, inMaxY] = innerBounds;
	const [outMinX, outMinY, outMaxX, outMaxY] = outerBounds;

	return inMinX >= outMinX && inMinY >= outMinY && inMaxX <= outMaxX && inMaxY <= outMaxY;
};
