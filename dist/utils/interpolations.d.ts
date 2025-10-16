import { DimensionRange } from '../types';
export declare const noInterpolation: (values: Float32Array, index: number) => number;
export declare const interpolateLinear: (values: Float32Array, index: number, xFraction: number, yFraction: number, ranges: DimensionRange[]) => number;
export declare const interpolateCardinal2D: (values: Float32Array, nx: number, index: number, xFraction: number, yFraction: number, tension?: number) => number;
export declare const interpolate2DHermite: (values: Float32Array, index: number, xFraction: number, yFraction: number, ranges: DimensionRange[]) => number;
