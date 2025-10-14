import { GetResourceResponse, RequestParameters } from 'maplibre-gl';
import { TypedArray } from '@openmeteo/file-reader';
import { TileJSON, ColorScale } from './types';
export interface Data {
    values: TypedArray | undefined;
    directions: TypedArray | undefined;
}
export declare const getValueFromLatLong: (lat: number, lon: number, colorScale: ColorScale) => {
    index: number;
    value: number;
    direction?: number;
};
export declare const omProtocol: (params: RequestParameters) => Promise<GetResourceResponse<TileJSON | ImageBitmap>>;
