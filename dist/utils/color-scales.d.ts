import { ColorScale, Interpolator, Variable } from '../types';
type ColorScales = {
    [key: string]: ColorScale;
};
export declare const colorScales: ColorScales;
export declare function getColorScale(variable: Variable['value']): ColorScale;
export declare function getInterpolator(colorScale: ColorScale): Interpolator;
export {};
