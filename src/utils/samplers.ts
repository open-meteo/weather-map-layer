/**
 * Per-point samplers over one or more domain layers.
 *
 * Layers are ordered finest-first; at any point the finest layer with data
 * there wins. The raster, arrows, contours and grid points all sample through
 * the same functions, so a seamless composite switches models at the same
 * place (the finer layer's data edge) in every render path. A plain request is
 * the single-layer case.
 */
import { GridFactory } from '../grids/index';

import type { GridPointSource } from './grid-points';

import type { InterpolationMethod, LayerRenderData } from '../types';

export type ValueSampler = (lat: number, lon: number) => number;

export interface VectorSample {
	/** Magnitude (e.g. wind speed). */
	value: number;
	/** Direction in degrees, same convention as the source `directions` array. */
	direction: number;
}

export type VectorSampler = (lat: number, lon: number) => VectorSample;

export interface Samplers {
	sampleValue: ValueSampler;
	sampleVector: VectorSampler;
	/** The layers' grids and arrays for the grid-point layer, finest-first. */
	gridSources: GridPointSource[];
}

export const createSamplers = (
	layers: LayerRenderData[],
	method: InterpolationMethod
): Samplers => {
	const grids = layers.map((layer) => GridFactory.create(layer.domain.grid, layer.ranges));

	const sampleValue: ValueSampler = (lat, lon) => {
		for (let i = 0; i < layers.length; i++) {
			const values = layers[i].data.values;
			if (!values) continue;
			const value = grids[i].getInterpolatedValue(values, lat, lon, method);
			if (isFinite(value)) return value;
		}
		return NaN;
	};

	// The magnitude is sampled with the selected method so arrow size/colour
	// matches the raster; the direction is interpolated circularly (scalar
	// averaging flips arrows near the 0°/360° seam).
	const sampleVector: VectorSampler = (lat, lon) => {
		for (let i = 0; i < layers.length; i++) {
			const { values, directions } = layers[i].data;
			if (!values || !directions) continue;
			const value = grids[i].getInterpolatedValue(values, lat, lon, method);
			if (!isFinite(value)) continue;
			return { value, direction: grids[i].getLinearInterpolatedDirection(directions, lat, lon) };
		}
		return { value: NaN, direction: NaN };
	};

	const gridSources = layers.map((layer, i) => ({
		grid: grids[i],
		values: layer.data.values ?? new Float32Array(0),
		directions: layer.data.directions
	}));

	return { sampleValue, sampleVector, gridSources };
};
