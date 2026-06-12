/**
 * Per-point sampling helpers for seamless composite domains.
 *
 * Seamless layers are ordered finest-first.  At any geographic point the finest
 * layer that covers it wins, smoothly blending into the next coarser layer
 * across each layer's `blendWidthDeg` edge zone (smooth-step 3d²−2d³).  This is
 * the same blend the raster path uses, factored out here so the vector layers
 * (arrows, contours, grid points) render continuously across domain boundaries
 * instead of cutting off at the finest layer's footprint.
 */
import type { GridInterface } from '../grids/interface';

import { degreesToRadians, radiansToDegrees } from './math';

import type { SeamlessLayerRenderData } from '../types';

export type ValueSampler = (lat: number, lon: number) => number;

export interface VectorSample {
	/** Magnitude (e.g. wind speed). */
	value: number;
	/** Direction in degrees, same convention as the source `directions` array. */
	direction: number;
}

export type VectorSampler = (lat: number, lon: number) => VectorSample;

/**
 * Smooth-step weight of `layer` at (lat, lon): 1 deep inside the layer, falling
 * to 0 at the edge of its blend zone.  Returns 1 when the layer does not blend
 * (global fallback / `blendWidthDeg <= 0`).
 */
const edgeBlendWeight = (layer: SeamlessLayerRenderData, lat: number, lon: number): number => {
	if (layer.blendWidthDeg <= 0) return 1;
	const b = layer.domainBounds; // [lonMin, latMin, lonMax, latMax]
	const d = Math.min(
		(lon - b[0]) / layer.blendWidthDeg,
		(b[2] - lon) / layer.blendWidthDeg,
		(lat - b[1]) / layer.blendWidthDeg,
		(b[3] - lat) / layer.blendWidthDeg
	);
	if (d >= 1) return 1;
	return d * d * (3 - 2 * d); // smooth-step
};

/**
 * Recursively samples and blends a scalar field from seamless layers, starting
 * at `startIdx`.  Skips layers that do not cover the point (NaN) and blends with
 * the next coarser layer(s) inside the edge zone.
 */
const blendValue = (
	layerGrids: GridInterface[],
	seamlessLayers: SeamlessLayerRenderData[],
	lat: number,
	lon: number,
	startIdx: number
): number => {
	for (let i = startIdx; i < seamlessLayers.length; i++) {
		const layer = seamlessLayers[i];
		const vals = layer.data.values;
		if (!vals) continue;

		const value = layerGrids[i].getLinearInterpolatedValue(vals, lat, lon);
		if (!isFinite(value)) continue; // point not covered by this domain

		if (i === seamlessLayers.length - 1) return value;
		const t = edgeBlendWeight(layer, lat, lon);
		if (t >= 1) return value;

		const fallback = blendValue(layerGrids, seamlessLayers, lat, lon, i + 1);
		if (!isFinite(fallback)) return value;
		return value * t + fallback * (1 - t);
	}
	return NaN;
};

/** Blends a scalar field across all seamless layers at (lat, lon). */
export const sampleBlendedValue = (
	layerGrids: GridInterface[],
	seamlessLayers: SeamlessLayerRenderData[]
): ValueSampler => {
	return (lat, lon) => blendValue(layerGrids, seamlessLayers, lat, lon, 0);
};

/**
 * Recursively blends a wind vector across seamless layers.  Blending happens in
 * U/V component space so both magnitude and direction stay continuous across
 * domain seams (averaging raw bearings would wrap incorrectly near 0°/360°).
 */
const blendVector = (
	layerGrids: GridInterface[],
	seamlessLayers: SeamlessLayerRenderData[],
	lat: number,
	lon: number,
	startIdx: number
): { u: number; v: number } | null => {
	for (let i = startIdx; i < seamlessLayers.length; i++) {
		const layer = seamlessLayers[i];
		const vals = layer.data.values;
		const dirs = layer.data.directions;
		if (!vals || !dirs) continue;

		const speed = layerGrids[i].getLinearInterpolatedValue(vals, lat, lon);
		if (!isFinite(speed)) continue; // point not covered by this domain

		const rad = degreesToRadians(layerGrids[i].getLinearInterpolatedValue(dirs, lat, lon));
		const u = speed * Math.sin(rad);
		const v = speed * Math.cos(rad);

		if (i === seamlessLayers.length - 1) return { u, v };
		const t = edgeBlendWeight(layer, lat, lon);
		if (t >= 1) return { u, v };

		const fallback = blendVector(layerGrids, seamlessLayers, lat, lon, i + 1);
		if (!fallback) return { u, v };
		return { u: u * t + fallback.u * (1 - t), v: v * t + fallback.v * (1 - t) };
	}
	return null;
};

/** Blends a wind vector (magnitude + direction) across all seamless layers. */
export const sampleBlendedVector = (
	layerGrids: GridInterface[],
	seamlessLayers: SeamlessLayerRenderData[]
): VectorSampler => {
	return (lat, lon) => {
		const uv = blendVector(layerGrids, seamlessLayers, lat, lon, 0);
		if (!uv) return { value: NaN, direction: NaN };
		let direction = radiansToDegrees(Math.atan2(uv.u, uv.v));
		if (direction < 0) direction += 360;
		return { value: Math.hypot(uv.u, uv.v), direction };
	};
};
