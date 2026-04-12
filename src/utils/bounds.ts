import { lat2tile, lon2tile, tile2lat } from './math';

import { Bounds } from '../types';

/**
 * Snap bounds to tile boundaries for stable, padded data fetching.
 */
export const snapBounds = (viewportBounds: Bounds): Bounds => {
	const [minLon, minLat, maxLon, maxLat] = viewportBounds;

	const lonSpan = maxLon - minLon;

	// Pick a zoom where tiles are closest to viewport-sized
	const z = Math.max(0, Math.round(Math.log2(360 / lonSpan)));
	const numTiles = Math.pow(2, z);

	// Snap latitude via tile boundaries
	const minTileY = Math.max(0, Math.floor(lat2tile(maxLat, z)));
	const maxTileY = Math.min(numTiles, Math.ceil(lat2tile(minLat, z)));
	const snapMinLat = tile2lat(maxTileY, z);
	const snapMaxLat = tile2lat(minTileY, z);

	// Full-world longitude: use [-180, 180] but still snap latitude
	if (lonSpan >= 360) {
		return [-180, snapMinLat, 180, snapMaxLat];
	}

	// Snap longitude via tile boundaries
	const minTileX = Math.floor(lon2tile(minLon, z));
	const maxTileX = Math.ceil(lon2tile(maxLon, z));

	if (maxTileX - minTileX >= numTiles) {
		return [-180, snapMinLat, 180, snapMaxLat];
	}

	// Convert tile X range without modular wrap
	const snapMinLon = (minTileX / numTiles) * 360 - 180;
	const snapMaxLon = (maxTileX / numTiles) * 360 - 180;

	// If snapped bounds cross the dateline, fall back to full-world longitude
	if (snapMinLon < -180 || snapMaxLon > 180) {
		return [-180, snapMinLat, 180, snapMaxLat];
	}

	return [snapMinLon, snapMinLat, snapMaxLon, snapMaxLat];
};

export let currentBounds: Bounds | undefined = undefined;
export const updateCurrentBounds = (bounds: Bounds) => {
	const bbox = snapBounds(bounds);
	currentBounds = [bbox[0], bbox[1], bbox[2], bbox[3]];
};

export const boundsIncluded = (innerBounds: Bounds, outerBounds: Bounds): boolean => {
	const [inMinX, inMinY, inMaxX, inMaxY] = innerBounds;
	const [outMinX, outMinY, outMaxX, outMaxY] = outerBounds;

	return inMinX >= outMinX && inMinY >= outMinY && inMaxX <= outMaxX && inMaxY <= outMaxY;
};

/*
Compares domain bounds against bounds limitation set in clippingOptions.
Returns the intersection, or undefined when there is no overlap.
Both bounds and constraint may cross the antimeridian (minLon > maxLon).
*/
export const constrainBounds = (bounds: Bounds, constraint: Bounds): Bounds | undefined => {
	let [minLon, minLat, maxLon, maxLat] = bounds;
	const [clipMinLon, clipMinLat, clipMaxLon, clipMaxLat] = constraint;

	// Latitude: always simple clamping
	if (minLat < clipMinLat) minLat = clipMinLat;
	if (maxLat > clipMaxLat) maxLat = clipMaxLat;

	const boundsWraps = minLon > maxLon;
	const clipWraps = clipMinLon > clipMaxLon;

	if (!boundsWraps && !clipWraps) {
		// Standard contiguous case
		if (minLon < clipMinLon) minLon = clipMinLon;
		if (maxLon > clipMaxLon) maxLon = clipMaxLon;
	} else if (clipWraps && !boundsWraps) {
		// Bounds = [a, b]; Clip = [c1, 180] ∪ [-180, c2] (c1 > c2)
		// Intersection = ([max(a,c1), b] if non-empty) ∪ ([a, min(b,c2)] if non-empty)
		const rightStart = Math.max(minLon, clipMinLon);
		const rightEnd = maxLon;
		const rightNonEmpty = rightStart <= rightEnd;

		const leftStart = minLon;
		const leftEnd = Math.min(maxLon, clipMaxLon);
		const leftNonEmpty = leftStart <= leftEnd;

		if (rightNonEmpty && leftNonEmpty) {
			// Result wraps: right segment ∪ left segment
			minLon = rightStart;
			maxLon = leftEnd;
		} else if (rightNonEmpty) {
			minLon = rightStart;
			maxLon = rightEnd;
		} else if (leftNonEmpty) {
			minLon = leftStart;
			maxLon = leftEnd;
		} else {
			return undefined;
		}
	} else if (boundsWraps && !clipWraps) {
		// Bounds = [a, 180] ∪ [-180, b] (a > b); Clip = [c1, c2]
		const rightStart = Math.max(minLon, clipMinLon);
		const rightEnd = Math.min(180, clipMaxLon);
		const rightNonEmpty = rightStart <= rightEnd;

		const leftStart = Math.max(-180, clipMinLon);
		const leftEnd = Math.min(maxLon, clipMaxLon);
		const leftNonEmpty = leftStart <= leftEnd;

		if (rightNonEmpty && leftNonEmpty) {
			// Still wrapping
			minLon = rightStart;
			maxLon = leftEnd;
		} else if (rightNonEmpty) {
			minLon = rightStart;
			maxLon = rightEnd;
		} else if (leftNonEmpty) {
			minLon = leftStart;
			maxLon = leftEnd;
		} else {
			return undefined;
		}
	} else {
		// Both wrap: Bounds = [a, 180] ∪ [-180, b]; Clip = [c1, 180] ∪ [-180, c2]
		// Intersection: [max(a, c1), min(b, c2)] (still wrapping)
		minLon = Math.max(minLon, clipMinLon);
		maxLon = Math.min(maxLon, clipMaxLon);
	}

	return [minLon, minLat, maxLon, maxLat];
};

export const checkAgainstBounds = (point: number, min: number, max: number) => {
	if (max < min) {
		if (point < min && point > max) {
			return true;
		} else {
			return false;
		}
	} else {
		if (point < min || point > max) {
			return true;
		} else {
			return false;
		}
	}
};
