import inside from 'point-in-polygon-hao';

import { lat2tile, lon2tile } from './math';

import { Bounds, ClippingOptions, GeoJson, GeoJsonGeometry, GeoJsonPosition } from '../types';

/**
 * Flat representation of clipping polygons.
 * When `useSAB` is true the backing buffer is a SharedArrayBuffer (zero-copy
 * across workers); otherwise a regular ArrayBuffer is used.
 *
 * Polygon grouping is preserved so that holes are correctly excluded:
 * `polygonOffsets[p]` .. `polygonOffsets[p+1]` gives the range of ring indices
 * belonging to polygon *p* (first ring = outer boundary, rest = holes).
 */
export type SharedPolygons = {
	/** Flat [lon, lat, …] pairs for all rings. */
	coordinates: Float64Array;
	/** Ring start indices (element offsets into `coordinates`). Length = numRings + 1. */
	offsets: Uint32Array;
	/** Polygon start indices (indices into `offsets`). Length = numPolygons + 1. */
	polygonOffsets: Uint32Array;
};

export type ResolvedClippingOptions = {
	polygons?: SharedPolygons;
	bounds?: Bounds;
	fillRule: 'nonzero' | 'evenodd';
};

/** Number of rings stored in a SharedPolygons structure. */
export const sharedPolygonsRingCount = (sp: SharedPolygons): number => sp.offsets.length - 1;

/** Number of polygons stored in a SharedPolygons structure. */
export const sharedPolygonsPolygonCount = (sp: SharedPolygons): number =>
	sp.polygonOffsets.length - 1;

/** Extract ring *i* as a plain `number[][]` (each element `[lon, lat]`). */
export const sharedPolygonsRing = (sp: SharedPolygons, i: number): number[][] => {
	const start = sp.offsets[i];
	const end = sp.offsets[i + 1];
	const ring: number[][] = [];
	for (let j = start; j < end; j += 2) {
		ring.push([sp.coordinates[j], sp.coordinates[j + 1]]);
	}
	return ring;
};

/**
 * Creates a reusable point-in-clipping tester from resolved clipping options.
 * Pre-computes the wrapped polygon arrays and bounds so the hot loop only
 * does an O(1) bounds check followed by the point-in-polygon raycast when
 * actually needed.
 *
 * Returns `undefined` when there are no polygon constraints — callers can
 * skip the test entirely.
 */
export const createClippingTester = (
	clippingOptions: ResolvedClippingOptions | undefined
): ((lon: number, lat: number) => boolean) | undefined => {
	const sp = clippingOptions?.polygons;
	if (!sp || sp.polygonOffsets.length <= 1) return undefined;

	// Project polygon vertices to Mercator space
	const polygons: number[][][][] = [];
	const numPolygons = sharedPolygonsPolygonCount(sp);
	for (let p = 0; p < numPolygons; p++) {
		const firstRing = sp.polygonOffsets[p];
		const lastRing = sp.polygonOffsets[p + 1];
		const rings: number[][][] = [];
		for (let r = firstRing; r < lastRing; r++) {
			const geoRing = sharedPolygonsRing(sp, r);
			rings.push(geoRing.map(([lon, lat]) => [lon2tile(lon, 0), lat2tile(lat, 0)]));
		}
		polygons.push(rings);
	}

	// Pre-extract bounds for a fast AABB rejection (O(1) per point).
	const bounds = clippingOptions?.bounds;

	// Reusable point array to avoid allocating [lon, lat] per call.
	const point: [number, number] = [0, 0];

	const fillRule = clippingOptions?.fillRule ?? 'nonzero';

	return (lon: number, lat: number): boolean => {
		// Fast bounds rejection (geographic coordinates are fine here)
		if (bounds) {
			const [minLon, minLat, maxLon, maxLat] = bounds;
			if (lat < minLat || lat > maxLat) return false;
			// Handle dateline-crossing bounds (minLon > maxLon):
			// valid range is [minLon..180] ∪ [-180..maxLon].
			if (minLon <= maxLon) {
				if (lon < minLon || lon > maxLon) return false;
			} else {
				if (lon > maxLon && lon < minLon) return false;
			}
		}

		// Project the test point to the same Mercator space as the polygon
		point[0] = lon2tile(lon, 0);
		point[1] = lat2tile(lat, 0);

		if (fillRule === 'evenodd') {
			let count = 0;
			for (const polygon of polygons) {
				if (inside(point, polygon)) count++;
			}
			return count % 2 === 1;
		}

		return polygons.some((polygon) => !!inside(point, polygon));
	};
};

export const resolveClippingOptions = (
	options: ClippingOptions,
	useSAB = false
): ResolvedClippingOptions | undefined => {
	if (!options) return undefined;

	// Collect rings grouped by polygon, then pack into flat buffers at the end.
	// Each entry in `polygonRings` is one polygon: [outerRing, hole1, hole2, …].
	const polygonRings: [number, number][][][] = [];
	let bounds = options.bounds;

	let combinedMinLon = Infinity;
	let combinedMaxLon = -Infinity;
	let combinedMinLat = Infinity;
	let combinedMaxLat = -Infinity;

	const extendBoundsWithRing = (ring: [number, number][]) => {
		for (const [lon, lat] of ring) {
			if (lon < combinedMinLon) combinedMinLon = lon;
			if (lon > combinedMaxLon) combinedMaxLon = lon;
			if (lat < combinedMinLat) combinedMinLat = lat;
			if (lat > combinedMaxLat) combinedMaxLat = lat;
		}
	};

	const toCoord2 = (position: GeoJsonPosition): [number, number] => {
		const lon = position[0];
		const lat = position[1];
		if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
			throw new Error('Invalid GeoJSON position: expected [lon, lat] with finite numbers.');
		}
		return [lon, lat];
	};

	const samePoint = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

	const closeRing = (ring: [number, number][]) => {
		if (ring.length === 0) return ring;
		const first = ring[0];
		const last = ring[ring.length - 1];
		if (!samePoint(first, last)) ring.push([first[0], first[1]]);
		return ring;
	};

	if (options.geojson) {
		const addPolygon = (geoRings: GeoJsonPosition[][]) => {
			const processedRings: [number, number][][] = [];
			for (const ring of geoRings) {
				const normalizedRing = ring.map((position) => toCoord2(position));
				if (!bounds) {
					extendBoundsWithRing(normalizedRing);
				}
				if (normalizedRing.length === 0) continue;
				processedRings.push(closeRing(normalizedRing));
			}
			if (processedRings.length > 0) {
				polygonRings.push(processedRings);
			}
		};

		const addGeometry = (geometry: GeoJsonGeometry | null) => {
			if (!geometry) return;
			if (geometry.type === 'Polygon') {
				addPolygon(geometry.coordinates);
				return;
			}
			if (geometry.type === 'MultiPolygon') {
				for (const polygon of geometry.coordinates) {
					addPolygon(polygon);
				}
				return;
			}
			if (geometry.type === 'GeometryCollection') {
				for (const geom of geometry.geometries) {
					addGeometry(geom);
				}
				return;
			}

			// Ignore non-polygon geometries for clipping.
			return;
		};

		const geojson: GeoJson = options.geojson;
		if (geojson.type === 'FeatureCollection') {
			for (const feature of geojson.features) {
				if (feature.geometry) {
					addGeometry(feature.geometry);
				}
			}
		} else if (geojson.type === 'Feature') {
			if (geojson.geometry) {
				addGeometry(geojson.geometry);
			}
		} else {
			addGeometry(geojson);
		}
	}

	if (!bounds && combinedMinLon !== Infinity) {
		bounds = [combinedMinLon, combinedMinLat, combinedMaxLon, combinedMaxLat];
	}

	if (!bounds && polygonRings.length === 0) return undefined;

	// Pack collected rings into flat typed arrays (SharedArrayBuffer when useSAB is true).
	let sharedPolygons: SharedPolygons | undefined;
	if (polygonRings.length > 0) {
		// Flatten to count totals
		const allRings: [number, number][][] = [];
		const polygonBoundaries: number[] = [0];
		for (const polygon of polygonRings) {
			for (const ring of polygon) {
				allRings.push(ring);
			}
			polygonBoundaries.push(allRings.length);
		}

		let totalElements = 0;
		for (const ring of allRings) totalElements += ring.length * 2;

		const coordBytes = totalElements * Float64Array.BYTES_PER_ELEMENT;
		const ringOffsetBytes = (allRings.length + 1) * Uint32Array.BYTES_PER_ELEMENT;
		const polyOffsetBytes = polygonBoundaries.length * Uint32Array.BYTES_PER_ELEMENT;
		const coordBuffer = useSAB ? new SharedArrayBuffer(coordBytes) : new ArrayBuffer(coordBytes);
		const coordinates = new Float64Array(coordBuffer);
		const ringOffsetBuffer = useSAB
			? new SharedArrayBuffer(ringOffsetBytes)
			: new ArrayBuffer(ringOffsetBytes);
		const offsets = new Uint32Array(ringOffsetBuffer);
		const polyOffsetBuffer = useSAB
			? new SharedArrayBuffer(polyOffsetBytes)
			: new ArrayBuffer(polyOffsetBytes);
		const polygonOffsets = new Uint32Array(polyOffsetBuffer);

		let idx = 0;
		for (let r = 0; r < allRings.length; r++) {
			offsets[r] = idx;
			for (const [lon, lat] of allRings[r]) {
				coordinates[idx++] = lon;
				coordinates[idx++] = lat;
			}
		}
		offsets[allRings.length] = idx;

		for (let p = 0; p < polygonBoundaries.length; p++) {
			polygonOffsets[p] = polygonBoundaries[p];
		}

		sharedPolygons = { coordinates, offsets, polygonOffsets };
	}

	return { polygons: sharedPolygons, bounds, fillRule: options.fillRule ?? 'nonzero' };
};

export const clipRasterToPolygons = (
	canvas: OffscreenCanvas,
	tileSize: number,
	z: number,
	x: number,
	y: number,
	clippingOptions: ResolvedClippingOptions
): ImageBitmap => {
	const sp = clippingOptions.polygons;
	if (!sp) {
		return canvas.transferToImageBitmap();
	}

	const numRings = sharedPolygonsRingCount(sp);
	if (numRings === 0) {
		return canvas.transferToImageBitmap();
	}

	const clipCanvas = new OffscreenCanvas(tileSize, tileSize);
	const clipContext = clipCanvas.getContext('2d');

	if (!clipContext) {
		throw new Error('Could not initialise canvas context');
	}

	clipContext.beginPath();
	for (let r = 0; r < numRings; r++) {
		const ring = sharedPolygonsRing(sp, r);
		for (let i = 0; i < ring.length; i++) {
			const [polyX, polyY] = ring[i];
			const polyXtile = (lon2tile(polyX, z) - x) * tileSize;
			const polyYtile = (lat2tile(polyY, z) - y) * tileSize;
			if (i === 0) {
				clipContext.moveTo(polyXtile, polyYtile);
			} else {
				clipContext.lineTo(polyXtile, polyYtile);
			}
		}
		clipContext.closePath();
	}

	clipContext.clip(clippingOptions.fillRule);
	clipContext.drawImage(canvas, 0, 0);

	return clipCanvas.transferToImageBitmap();
};
