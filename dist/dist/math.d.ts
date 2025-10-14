declare class DynamicProjection {
    constructor(projName: any, opts: any);
}
declare class LambertConformalConicProjection {
    constructor(projectionData: any);
    R: any;
    λ0: number;
    n: number;
    F: number;
    ρ0: number;
    forward(latitude: any, longitude: any): number[];
    reverse(x: any, y: any): number[];
}
declare class MercatorProjection {
    forward(latitude: any, longitude: any): number[];
    reverse(x: any, y: any): number[];
}
declare class ProjectionGrid {
    constructor(projection: any, grid: any, ranges?: {
        start: number;
        end: any;
    }[]);
    ranges: {
        start: number;
        end: any;
    }[];
    projection: any;
    nx: any;
    ny: any;
    origin: any;
    dx: any;
    dy: any;
    findPointInterpolated(lat: any, lon: any, ranges: any): {
        index: number;
        xFraction: number;
        yFraction: number;
    };
}
declare class RotatedLatLonProjection {
    constructor(projectionData: any);
    θ: number;
    ϕ: number;
    forward(latitude: any, longitude: any): number[];
    reverse(x: any, y: any): number[];
}
declare class StereograpicProjection {
    constructor(projectionData: any);
    R: any;
    λ0: number;
    sinϕ1: number;
    cosϕ1: number;
    forward(latitude: any, longitude: any): number[];
    reverse(x: any, y: any): number[];
}
declare function getBoundsFromBorderPoints(borderPoints: any, projection: any): number[];
declare function getCenterFromGrid(grid: any): {
    lng: any;
    lat: any;
};
declare function getCenterFromBounds(bounds: any): {
    lng: any;
    lat: any;
};
declare function getIndicesFromBounds(south: any, west: any, north: any, east: any, domain: any): any[];
declare function getBoundsFromGrid(lonMin: any, latMin: any, dx: any, dy: any, nx: any, ny: any): any[];
declare function getIndexFromLatLong(lat: any, lon: any, dx: any, dy: any, nx: any, latLonMinMax: any): {
    index: number;
    xFraction: number;
    yFraction: number;
};
declare function getBorderPoints(projectionGrid: any): any[][];
declare class LambertAzimuthalEqualAreaProjection {
    constructor(projectionData: any);
    R: any;
    λ0: number;
    ϕ1: number;
    forward(latitude: any, longitude: any): number[];
    reverse(x: any, y: any): number[];
}
declare function degreesToRadians(degree: any): number;
declare function tile2lat(y: any, z: any): number;
declare function lat2tile(lat: any, z: any): number;
declare function lon2tile(lon: any, z: any): number;
declare function hermite(t: any, p0: any, p1: any, m0: any, m1: any): number;
declare function derivative(fm1: any, fp1: any): number;
declare function getRotatedSWNE(domain: any, projection: any, [south, west, north, east]: [any, any, any, any]): number[];
declare function rotatePoint(cx: any, cy: any, theta: any, x: any, y: any): any[];
declare function radiansToDegrees(rad: any): number;
declare function secondDerivative(fm1: any, f0: any, fp1: any): any;
declare function tile2lon(x: any, z: any): number;
export { DynamicProjection as D, LambertConformalConicProjection as L, MercatorProjection as M, ProjectionGrid as P, RotatedLatLonProjection as R, StereograpicProjection as S, getBoundsFromBorderPoints as a, getCenterFromGrid as b, getCenterFromBounds as c, getIndicesFromBounds as d, getBoundsFromGrid as e, getIndexFromLatLong as f, getBorderPoints as g, LambertAzimuthalEqualAreaProjection as h, degreesToRadians as i, tile2lat as j, lat2tile as k, lon2tile as l, hermite as m, derivative as n, getRotatedSWNE as o, rotatePoint as p, radiansToDegrees as r, secondDerivative as s, tile2lon as t };
