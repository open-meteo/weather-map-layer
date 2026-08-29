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

let clippingBounds: Bounds | undefined = undefined;
export const setClippingBounds = (newClippingBounds?: Bounds): void => {
	if (
		clippingBounds &&
		newClippingBounds &&
		clippingBounds[0] === newClippingBounds[0] &&
		clippingBounds[1] === newClippingBounds[1] &&
		clippingBounds[2] === newClippingBounds[2] &&
		clippingBounds[3] === newClippingBounds[3]
	) {
		// No change in clipping bounds
		return;
	}
	clippingBounds = newClippingBounds;
};

export let currentBounds: Bounds | undefined = undefined;
export const updateCurrentBounds = (viewportBounds: Bounds) => {
	// Snap to a stable grid first so small pans don't change the request
	let effectiveBounds = snapBounds(viewportBounds);

	// Then constrain to clipping bounds
	if (clippingBounds) {
		effectiveBounds = constrainBounds(effectiveBounds, clippingBounds) ?? effectiveBounds;
	}

	currentBounds = effectiveBounds;
};

export const boundsIncluded = (innerBounds: Bounds, outerBounds: Bounds): boolean => {
	const [inMinX, inMinY, inMaxX, inMaxY] = innerBounds;
	const [outMinX, outMinY, outMaxX, outMaxY] = outerBounds;

	return inMinX >= outMinX && inMinY >= outMinY && inMaxX <= outMaxX && inMaxY <= outMaxY;
};

/** True when two longitude spans overlap, treating a span with min > max as
 *  dateline-crossing ([min..180] ∪ [-180..max]). */
const lonRangesOverlap = (aMin: number, aMax: number, bMin: number, bMax: number): boolean => {
	const aWraps = aMin > aMax;
	const bWraps = bMin > bMax;
	if (!aWraps && !bWraps) return aMin <= bMax && bMin <= aMax;
	// A wrapping span always includes the antimeridian, so two wrapping spans
	// necessarily overlap there.
	if (aWraps && bWraps) return true;
	// Exactly one wraps: the non-wrapping span overlaps if it reaches either the
	// [min..180] or the [-180..max] segment of the wrapping one.
	if (aWraps) return bMax >= aMin || bMin <= aMax;
	return aMax >= bMin || aMin <= bMax;
};

/**
 * True when two lon/lat bounding boxes overlap (share any area). Latitude is a
 * plain interval test; longitude tolerates dateline-crossing boxes on either
 * side. Used to decide whether a domain is at least partially inside the map
 * viewport before loading/blending it.
 */
export const boundsIntersect = (a: Bounds, b: Bounds): boolean => {
	// Latitude never wraps.
	if (a[1] > b[3] || b[1] > a[3]) return false;
	return lonRangesOverlap(a[0], a[2], b[0], b[2]);
};

/*
Compares domain bounds against bounds limitation set in clippingOptions.
Returns undefined when the two bounds do not overlap at all.
Handles dateline-crossing bounds (minLon > maxLon) for both inputs.
*/
export const constrainBounds = (bounds: Bounds, constraint: Bounds): Bounds | undefined => {
	let [minLon, minLat, maxLon, maxLat] = bounds;
	const [clipMinLon, clipMinLat, clipMaxLon, clipMaxLat] = constraint;

	// Latitude is always a simple clamp — no dateline complexity.
	if (minLat < clipMinLat) minLat = clipMinLat;
	if (maxLat > clipMaxLat) maxLat = clipMaxLat;

	const boundsWraps = minLon > maxLon;
	const clipWraps = clipMinLon > clipMaxLon;

	if (!boundsWraps && !clipWraps) {
		// Standard case: both non-crossing.
		if (minLon < clipMinLon) minLon = clipMinLon;
		if (maxLon > clipMaxLon) maxLon = clipMaxLon;
		if (minLon > maxLon) return undefined;
	} else if (clipWraps && !boundsWraps) {
		// Clip crosses dateline: valid zone is [clipMinLon..180] ∪ [-180..clipMaxLon].
		// Bounds is fully in the gap when it sits between clipMaxLon and clipMinLon.
		const rightMin = Math.max(minLon, clipMinLon);
		const rightMax = Math.min(maxLon, 180);
		const leftMin = Math.max(minLon, -180);
		const leftMax = Math.min(maxLon, clipMaxLon);
		const hasRight = rightMin <= rightMax;
		const hasLeft = leftMin <= leftMax;
		if (!hasRight && !hasLeft) return undefined;
		if (hasRight && !hasLeft) {
			minLon = rightMin;
			maxLon = rightMax;
		} else if (!hasRight && hasLeft) {
			minLon = leftMin;
			maxLon = leftMax;
		} else {
			// The bounds spans both valid clip segments, so the result wraps.
			minLon = rightMin;
			maxLon = leftMax;
		}
	} else if (!clipWraps && boundsWraps) {
		// Bounds crosses dateline: covers [minLon..180] ∪ [-180..maxLon].
		// Intersect each half with the non-crossing clip.
		const rightMin = Math.max(minLon, clipMinLon);
		const rightMax = Math.min(180, clipMaxLon);
		const leftMin = Math.max(-180, clipMinLon);
		const leftMax = Math.min(maxLon, clipMaxLon);
		const hasRight = rightMin <= rightMax;
		const hasLeft = leftMin <= leftMax;
		if (!hasRight && !hasLeft) return undefined;
		if (hasRight && !hasLeft) {
			minLon = rightMin;
			maxLon = rightMax;
		} else if (!hasRight && hasLeft) {
			minLon = leftMin;
			maxLon = leftMax;
		} else {
			// Both halves survived — result stays dateline-crossing.
			minLon = rightMin;
			maxLon = leftMax;
		}
	} else {
		// Both cross dateline: intersect by clamping each edge independently.
		if (minLon < clipMinLon) minLon = clipMinLon;
		if (maxLon > clipMaxLon) maxLon = clipMaxLon;
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
