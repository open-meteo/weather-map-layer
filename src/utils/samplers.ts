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
import { halfQuantum } from './math';

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
	/**
	 * `sampleValue` plus half the quantization step of the layer that supplied
	 * the value. Colour bands and contours test their thresholds against this,
	 * so band edges fall inside grid cells (smooth) instead of snapping to the
	 * cell corners when a breakpoint coincides with a quantization level. Each
	 * layer's file has its own scale factor, so the offset follows the layer.
	 */
	sampleThresholdValue: ValueSampler;
	sampleVector: VectorSampler;
	/** The layers' grids and arrays for the grid-point layer, finest-first. */
	gridSources: GridPointSource[];
}

export const createSamplers = (
	layers: LayerRenderData[],
	method: InterpolationMethod
): Samplers => {
	const grids = layers.map((layer) => GridFactory.create(layer.domain.grid, layer.ranges));
	const halfQuanta = layers.map((layer) => halfQuantum(layer.data.scaleFactor));

	// The finest layer with a finite value at the point, or -1. The value itself
	// is left in `sampled` so the hot path returns two things without allocating.
	let sampled = NaN;
	const sampleLayer = (lat: number, lon: number): number => {
		for (let i = 0; i < layers.length; i++) {
			const values = layers[i].data.values;
			if (!values) continue;
			const value = grids[i].getInterpolatedValue(values, lat, lon, method);
			if (isFinite(value)) {
				sampled = value;
				return i;
			}
		}
		return -1;
	};

	const sampleValue: ValueSampler = (lat, lon) => (sampleLayer(lat, lon) < 0 ? NaN : sampled);

	const sampleThresholdValue: ValueSampler = (lat, lon) => {
		const i = sampleLayer(lat, lon);
		return i < 0 ? NaN : sampled + halfQuanta[i];
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

	return { sampleValue, sampleThresholdValue, sampleVector, gridSources };
};
