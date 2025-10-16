import { Data } from './om-protocol';
import { Domain, Variable, DimensionRange } from './types';
export interface TileRequest {
    type: 'GT';
    x: number;
    y: number;
    z: number;
    key: string;
    data: Data;
    domain: Domain;
    variable: Variable;
    ranges: DimensionRange[];
    dark: boolean;
    mapBounds: number[];
    iconPixelData: Record<string, ImageDataArray>;
}
export type TileResponse = {
    type: 'RT';
    tile: ImageBitmap;
    key: string;
};
export declare class WorkerPool {
    private workers;
    private nextWorker;
    /** Stores pending tile requests by key to avoid duplicate requests for the same tile */
    private pendingTiles;
    /** Stores resolve functions for pending promises, used to fulfill promises when worker responses arrive */
    private resolvers;
    constructor();
    private handleMessage;
    getNextWorker(): Worker | undefined;
    requestTile(request: TileRequest): Promise<ImageBitmap>;
}
