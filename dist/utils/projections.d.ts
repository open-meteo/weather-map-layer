import { Domain, DimensionRange } from '../types';
export interface Projection {
    forward(latitude: number, longitude: number): [x: number, y: number];
    reverse(x: number, y: number): [latitude: number, longitude: number];
}
export declare class MercatorProjection implements Projection {
    forward(latitude: number, longitude: number): [x: number, y: number];
    reverse(x: number, y: number): [latitude: number, longitude: number];
}
export declare class RotatedLatLonProjection implements Projection {
    θ: number;
    ϕ: number;
    constructor(projectionData: Domain['grid']['projection']);
    forward(latitude: number, longitude: number): [x: number, y: number];
    reverse(x: number, y: number): [latitude: number, longitude: number];
}
export declare class LambertConformalConicProjection implements Projection {
    ρ0: number;
    F: number;
    n: number;
    λ0: number;
    R: number;
    constructor(projectionData: Domain['grid']['projection']);
    forward(latitude: number, longitude: number): [x: number, y: number];
    reverse(x: number, y: number): [latitude: number, longitude: number];
}
export declare class LambertAzimuthalEqualAreaProjection implements Projection {
    λ0: number;
    ϕ1: number;
    R: number;
    constructor(projectionData: Domain['grid']['projection']);
    forward(latitude: number, longitude: number): [x: number, y: number];
    reverse(x: number, y: number): [latitude: number, longitude: number];
}
export declare class StereograpicProjection implements Projection {
    λ0: number;
    sinϕ1: number;
    cosϕ1: number;
    R: number;
    constructor(projectionData: Domain['grid']['projection']);
    forward(latitude: number, longitude: number): [x: number, y: number];
    reverse(x: number, y: number): [latitude: number, longitude: number];
}
declare const projections: {
    MercatorProjection: typeof MercatorProjection;
    StereograpicProjection: typeof StereograpicProjection;
    RotatedLatLonProjection: typeof RotatedLatLonProjection;
    LambertConformalConicProjection: typeof LambertConformalConicProjection;
    LambertAzimuthalEqualAreaProjection: typeof LambertAzimuthalEqualAreaProjection;
};
export type ProjectionName = keyof typeof projections;
export declare class DynamicProjection {
    constructor(projName: ProjectionName, opts: Domain['grid']['projection']);
}
export declare class ProjectionGrid {
    projection: Projection;
    nx: number;
    ny: number;
    origin: number[];
    dx: number;
    dy: number;
    ranges: DimensionRange[];
    constructor(projection: Projection, grid: Domain['grid'], ranges?: DimensionRange[]);
    findPointInterpolated(lat: number, lon: number, ranges: DimensionRange[]): {
        index: number;
        xFraction: number;
        yFraction: number;
    };
}
export {};
