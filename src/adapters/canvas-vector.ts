/**
 * Vector tile features prepared for canvas rendering, shared by the adapters
 * for libraries without a vector tile renderer of their own (Leaflet, Cesium):
 * they decode the protocol's PBF tiles, resolve a style per feature and draw
 * the result onto a tile-sized canvas (see `leaflet-worker/`).
 */
import type { VectorTile } from '@mapbox/vector-tile';

import type { ExtractedFeatures, RenderFeature } from './leaflet-worker/leaflet-pbf-worker-pool';

/**
 * Style callback for vector tile features drawn on a canvas.
 *
 * Return `null` / `undefined` to skip the feature.
 */
export interface CanvasVectorStyle {
	strokeStyle?: string | ((value: number) => string);
	lineWidth?: number | ((value: number) => number);
	lineCap?: CanvasLineCap;
	globalAlpha?: number | ((value: number) => number);
}

export type CanvasVectorStyleFn = (
	properties: Record<string, unknown>,
	layerName: string
) => CanvasVectorStyle | null | undefined;

/** The default vector tile extent used by the PBF encoder. */
const VECTOR_TILE_EXTENT = 4096;

/** Default arrow style: semi-transparent dark lines, width based on wind speed. */
export const defaultVectorStyle: CanvasVectorStyleFn = (properties) => {
	const value = Number(properties['value']) || 0;
	const alpha = value > 5 ? 0.6 : value > 4 ? 0.5 : value > 3 ? 0.4 : value > 2 ? 0.3 : 0.2;
	const width = value > 10 ? 3.5 : value > 5 ? 3 : 2;
	return {
		strokeStyle: `rgba(0, 0, 0, ${alpha})`,
		lineWidth: width,
		lineCap: 'round'
	};
};

/**
 * Extract pre-processed features from a decoded MVT.
 *
 * Resolves styles via the user's `styleFn` and converts geometry to pixel
 * coordinates. The result can be passed to the worker or the main-thread
 * fallback for canvas rendering.
 *
 * Geometry is drawn exactly where the tile puts it. The protocol lays
 * arrows and barbs out on a lattice whose far edge is shared with the
 * neighbouring tile, so each tile draws its half of an edge shape and the
 * seam only lines up when nothing is rescaled or thinned here.
 */
export const extractRenderFeatures = (
	vectorTile: VectorTile,
	tileSize: number,
	styleFn: CanvasVectorStyleFn
): ExtractedFeatures => {
	const scale = tileSize / VECTOR_TILE_EXTENT;
	const features: RenderFeature[] = [];

	for (const layerName of Object.keys(vectorTile.layers)) {
		const layer = vectorTile.layers[layerName];

		for (let i = 0; i < layer.length; i++) {
			const feature = layer.feature(i);
			// Inject the MVT layer name as `layer` so style functions can filter by source layer
			const props: Record<string, unknown> = { layer: layerName, ...feature.properties };
			const style = styleFn(props, layerName);
			if (!style) continue;

			const value = Number(props['value']) || 0;

			const strokeStyle =
				typeof style.strokeStyle === 'function'
					? style.strokeStyle(value)
					: (style.strokeStyle ?? 'rgba(0, 0, 0, 0.4)');
			const rawLineWidth =
				typeof style.lineWidth === 'function' ? style.lineWidth(value) : (style.lineWidth ?? 1.5);
			const lineCap = style.lineCap ?? 'round';
			const globalAlpha =
				typeof style.globalAlpha === 'function'
					? style.globalAlpha(value)
					: (style.globalAlpha ?? 1);

			const geometry = feature.loadGeometry();

			let renderType = feature.type;
			// Point
			if (renderType === 1) {
				for (const ring of geometry) {
					if (ring.length > 1) {
						renderType = 2; // LineString
						break;
					}
				}
			}

			const rings: number[][] = [];
			for (const ring of geometry) {
				const coords: number[] = [];
				for (const pt of ring) {
					coords.push(pt.x * scale, pt.y * scale);
				}
				rings.push(coords);
			}

			features.push({
				type: renderType as 1 | 2 | 3,
				rings,
				strokeStyle,
				lineWidth: rawLineWidth,
				lineCap,
				globalAlpha,
				fill: renderType === 3 && !!style.strokeStyle,
				pointRadius: rawLineWidth * 1.5
			});
		}
	}

	return { features };
};
