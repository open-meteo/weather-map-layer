import { GetResourceResponse, RequestParameters } from 'maplibre-gl';
import { TileJSON, ColorScale } from './types';
export interface Data {
    values: Float32Array | undefined;
    directions: Float32Array | undefined;
}
export declare const getValueFromLatLong: (lat: number, lon: number, colorScale: ColorScale) => {
    index: number;
    value: number;
    direction?: number;
};
export declare const omProtocol: (params: RequestParameters) => Promise<GetResourceResponse<TileJSON | ImageBitmap>>;
