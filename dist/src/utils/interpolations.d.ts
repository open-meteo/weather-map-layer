import { DimensionRange } from '../types';
import { TypedArray } from '@openmeteo/file-reader';
export declare const noInterpolation: (values: TypedArray, index: number) => number;
export declare const interpolateLinear: (values: TypedArray, index: number, xFraction: number, yFraction: number, ranges: DimensionRange[]) => number;
export declare const interpolateCardinal2D: (values: TypedArray, nx: number, index: number, xFraction: number, yFraction: number, tension?: number) => number;
export declare const interpolate2DHermite: (values: TypedArray, index: number, xFraction: number, yFraction: number, ranges: DimensionRange[]) => number;
