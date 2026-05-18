import { describe, expect, test } from 'vitest';

import { RegularGrid } from '../grids/regular';
import { RotatedLatLonProjection } from '../grids/projections';
import { parseWkt, wktToGridData } from '../utils/wkt';
import type {
	GaussianGridData,
	ProjectionGridFromBounds,
	RegularGridData,
	RotatedLatLonProjectionData
} from '../types';

// ============================================================================
// WKT strings matching the format produced by the open-meteo Swift server.
// These are constructed from the Swift crsWkt2 implementations.
// ============================================================================

/** ICON global, 0.125°, 2880×1441 (WGS 84 regular lat/lon) */
const ICON_GLOBAL_WKT = `GEOGCRS["WGS 84",
    DATUM["World Geodetic System 1984",
        ELLIPSOID["WGS 84",6378137,298.257223563]],
    CS[ellipsoidal,2],
        AXIS["latitude",north],
        AXIS["longitude",east],
        ANGLEUNIT["degree",0.0174532925199433]
    USAGE[
        SCOPE["grid"],
        BBOX[-90.0,0.0,90.0,359.875]]]`;

/** GFS 0.25°, 1440×721 (WGS 84 regular lat/lon) */
const GFS_025_WKT = `GEOGCRS["WGS 84",
    DATUM["World Geodetic System 1984",
        ELLIPSOID["WGS 84",6378137,298.257223563]],
    CS[ellipsoidal,2],
        AXIS["latitude",north],
        AXIS["longitude",east],
        ANGLEUNIT["degree",0.0174532925199433]
    USAGE[
        SCOPE["grid"],
        BBOX[-90.0,0.0,90.0,359.75]]]`;

/**
 * KNMI rotated lat/lon.
 * Swift: RotatedLatLonProjection(latitude: -35, longitude: -8)
 *   → θ = (90 + -35)° = 55°  → o_lat_p = -(55 - 90) = 35
 *   → ϕ = -8°                → lon_0 = -8
 */
const KNMI_ROTATED_WKT = `GEOGCRS["Rotated Lat/Lon",
    BASEGEOGCRS["GCS_Sphere",
        DATUM["D_Sphere",
            ELLIPSOID["Sphere",6371229.0,0.0]]],
    DERIVINGCONVERSION["Rotated Lat/Lon",
        METHOD["PROJ ob_tran o_proj=longlat"],
        PARAMETER["o_lon_p",0],
        PARAMETER["o_lat_p",35.0],
        PARAMETER["lon_0",-8.0]]
    CS[ellipsoidal,2],
        AXIS["latitude",north],
        AXIS["longitude",east],
        ANGLEUNIT["degree",0.0174532925199433],
    USAGE[
        SCOPE["grid"],
        BBOX[39.740627,-25.162262,62.619324,38.75702]]]`;

/**
 * MeteoSwiss rotated lat/lon.
 * Swift: RotatedLatLonProjection(latitude: 43.0, longitude: 190.0)
 *   → θ = (90 + 43)° = 133°  → o_lat_p = -(133 - 90) = -43  (NEGATIVE)
 *   → ϕ = 190°               → lon_0 = 190
 * The negative o_lat_p tests that the sign is handled correctly.
 */
const METEOSWISS_ROTATED_WKT = `GEOGCRS["Rotated Lat/Lon",
    BASEGEOGCRS["GCS_Sphere",
        DATUM["D_Sphere",
            ELLIPSOID["Sphere",6371229.0,0.0]]],
    DERIVINGCONVERSION["Rotated Lat/Lon",
        METHOD["PROJ ob_tran o_proj=longlat"],
        PARAMETER["o_lon_p",0],
        PARAMETER["o_lat_p",-43.0],
        PARAMETER["lon_0",190.0]]
    CS[ellipsoidal,2],
        AXIS["latitude",north],
        AXIS["longitude",east],
        ANGLEUNIT["degree",0.0174532925199433],
    USAGE[
        SCOPE["grid"],
        BBOX[39.0,1.0,50.0,18.0]]]`;

/** Stereographic polar (ICON Arctic). lat=90°, lon=0°, radius=6371229 */
const STEREO_WKT = `PROJCRS["Stereographic",
    BASEGEOGCRS["GCS_Sphere",
        DATUM["D_Sphere",
            ELLIPSOID["Sphere",6371229.0,0.0]]],
    CONVERSION["Stereographic",
        METHOD["Stereographic"],
        PARAMETER["Latitude of natural origin", 90.0],
        PARAMETER["Longitude of natural origin", 0.0],
        PARAMETER["Scale factor at natural origin", 1.0],
        PARAMETER["False easting", 0.0],
        PARAMETER["False northing", 0.0]],
    CS[Cartesian,2],
        AXIS["easting",east],
        AXIS["northing",north],
        LENGTHUNIT["metre",1.0],
    USAGE[
        SCOPE["grid"],
        BBOX[56.0,-120.0,90.0,120.0]]]`;

/**
 * Lambert Conformal Conic (DMI domain).
 * λ0=352°, ϕ0=ϕ1=ϕ2=55.5°, radius=6371229
 */
const LCC_WKT = `PROJCRS["Lambert Conic Conformal",
    BASEGEOGCRS["GCS_Sphere",
        DATUM["D_Sphere",
            ELLIPSOID["Sphere",6371229.0,0.0]]],
    CONVERSION["Lambert Conic Conformal",
        METHOD["Lambert Conic Conformal (2SP)"],
        PARAMETER["Latitude of 1st standard parallel",55.5],
        PARAMETER["Latitude of 2nd standard parallel",55.5],
        PARAMETER["Latitude of false origin",55.5],
        PARAMETER["Longitude of false origin",352.0]],
    CS[Cartesian,2],
        AXIS["easting",east],
        AXIS["northing",north],
        LENGTHUNIT["metre",1],
    USAGE[
        SCOPE["grid"],
        BBOX[39.671,-25.421997,72.5,56.0]]]`;

/** Lambert Azimuthal Equal-Area. lat=52°, lon=10°, radius=6371229 */
const LAEA_WKT = `PROJCRS["Lambert Azimuthal Equal-Area",
    BASEGEOGCRS["GCS_Sphere",
        DATUM["D_Sphere",
            ELLIPSOID["Sphere",6371229.0,0.0]]],
    CONVERSION["Lambert Azimuthal Equal-Area",
        METHOD["Lambert Azimuthal Equal-Area"],
        PARAMETER["Latitude of natural origin", 52.0],
        PARAMETER["Longitude of natural origin", 10.0],
        PARAMETER["False easting", 0.0],
        PARAMETER["False northing", 0.0]],
    CS[Cartesian,2],
        AXIS["easting",east],
        AXIS["northing",north],
        LENGTHUNIT["metre",1.0],
    USAGE[
        SCOPE["grid"],
        BBOX[29.0,-23.0,73.0,45.0]]]`;

/** ECMWF Reduced Gaussian Grid O1280 */
const GAUSSIAN_O1280_WKT = `GEOGCRS["Reduced Gaussian Grid",
    DATUM["World Geodetic System 1984",
        ELLIPSOID["WGS 84",6378137,298.257223563]],
    CS[ellipsoidal,2],
        AXIS["latitude",north],
        AXIS["longitude",east],
        ANGLEUNIT["degree",0.0174532925199433],
    REMARK["Reduced Gaussian Grid O1280 (ECMWF)"],
    USAGE[
        SCOPE["grid"],
        BBOX[-90,-180.0,90,180]]]`;

/** ECMWF Reduced Gaussian Grid O320 */
const GAUSSIAN_O320_WKT = `GEOGCRS["Reduced Gaussian Grid",
    DATUM["World Geodetic System 1984",
        ELLIPSOID["WGS 84",6378137,298.257223563]],
    CS[ellipsoidal,2],
        AXIS["latitude",north],
        AXIS["longitude",east],
        ANGLEUNIT["degree",0.0174532925199433],
    REMARK["Reduced Gaussian Grid O320 (ECMWF)"],
    USAGE[
        SCOPE["grid"],
        BBOX[-90,-180.0,90,180]]]`;

// ============================================================================
// parseWkt – low-level tokeniser / parser
// ============================================================================

describe('parseWkt', () => {
	test('parses top-level node type and quoted name', () => {
		const node = parseWkt(ICON_GLOBAL_WKT);
		expect(node.type).toBe('GEOGCRS');
		expect(node.values[0]).toBe('WGS 84');
	});

	test('parses PROJCRS top-level type', () => {
		const node = parseWkt(STEREO_WKT);
		expect(node.type).toBe('PROJCRS');
		expect(node.values[0]).toBe('Stereographic');
	});

	test('parses nested DATUM child', () => {
		const node = parseWkt(ICON_GLOBAL_WKT);
		const datum = node.children['DATUM']?.[0];
		expect(datum).toBeDefined();
		expect(datum!.values[0]).toBe('World Geodetic System 1984');
	});

	test('parses ELLIPSOID with numeric values', () => {
		const node = parseWkt(ICON_GLOBAL_WKT);
		const ellipsoid = node.children['DATUM']?.[0]?.children['ELLIPSOID']?.[0];
		expect(ellipsoid).toBeDefined();
		expect(ellipsoid!.values[0]).toBe('WGS 84');
		expect(ellipsoid!.values[1]).toBe(6378137);
		expect(ellipsoid!.values[2]).toBe(298.257223563);
	});

	test('parses USAGE → BBOX with four numeric values', () => {
		const node = parseWkt(ICON_GLOBAL_WKT);
		const bbox = node.children['USAGE']?.[0]?.children['BBOX']?.[0];
		expect(bbox).toBeDefined();
		expect(bbox!.values).toEqual([-90, 0, 90, 359.875]);
	});

	test('parses REMARK as a child node with a string value', () => {
		const node = parseWkt(GAUSSIAN_O1280_WKT);
		const remark = node.children['REMARK']?.[0];
		expect(remark).toBeDefined();
		expect(remark!.values[0]).toBe('Reduced Gaussian Grid O1280 (ECMWF)');
	});

	test('parses DERIVINGCONVERSION PARAMETER values', () => {
		const node = parseWkt(KNMI_ROTATED_WKT);
		const deriving = node.children['DERIVINGCONVERSION']?.[0];
		expect(deriving).toBeDefined();
		const params = deriving!.children['PARAMETER'];
		expect(params).toHaveLength(3);
		const oLatP = params!.find((p) => p.values[0] === 'o_lat_p');
		expect(oLatP).toBeDefined();
		expect(oLatP!.values[1]).toBe(35);
	});

	test('parses negative PARAMETER value (MeteoSwiss o_lat_p=-43)', () => {
		const node = parseWkt(METEOSWISS_ROTATED_WKT);
		const deriving = node.children['DERIVINGCONVERSION']?.[0];
		const oLatP = deriving!.children['PARAMETER']!.find((p) => p.values[0] === 'o_lat_p');
		expect(oLatP!.values[1]).toBe(-43);
	});

	test('parses PROJCRS CONVERSION PARAMETER values', () => {
		const node = parseWkt(LCC_WKT);
		const conversion = node.children['CONVERSION']?.[0];
		expect(conversion).toBeDefined();
		const phi1 = conversion!.children['PARAMETER']!.find(
			(p) => p.values[0] === 'Latitude of 1st standard parallel'
		);
		expect(phi1!.values[1]).toBe(55.5);
	});
});

// ============================================================================
// wktToGridData – regular grids
// ============================================================================

describe('wktToGridData – regular grids', () => {
	test('ICON global: grid type, dimensions, origin', () => {
		const grid = wktToGridData(ICON_GLOBAL_WKT, 2880, 1441) as RegularGridData;
		expect(grid.type).toBe('regular');
		expect(grid.nx).toBe(2880);
		expect(grid.ny).toBe(1441);
		expect(grid.lonMin).toBe(0);
		expect(grid.latMin).toBe(-90);
	});

	test('ICON global: dx = 0.125° exactly (using nx-1 denominator)', () => {
		// The BBOX stores the positions of the first (lon=0) and last (lon=359.875)
		// grid points. dx = lonRange / (nx-1) = 359.875 / 2879 = 0.125 exactly
		// because 2879 × 0.125 = 359.875.
		const grid = wktToGridData(ICON_GLOBAL_WKT, 2880, 1441) as RegularGridData;
		expect(grid.dx).toBe(0.125);
		expect(grid.dy).toBe(0.125);
	});

	test('GFS 0.25°: dx = 0.25° exactly (using nx-1 denominator)', () => {
		// dx = 359.75 / (1440-1) = 359.75 / 1439 = 0.25 exactly
		// because 1439 × 0.25 = 359.75.
		const grid = wktToGridData(GFS_025_WKT, 1440, 721) as RegularGridData;
		expect(grid.type).toBe('regular');
		expect(grid.dx).toBe(0.25);
		expect(grid.dy).toBe(0.25);
	});

	test('ICON and GFS global grids both have RegularGrid lonMax = 360° (correct for global wrap)', () => {
		// Both global grids share the same upper longitude bound of 360°.
		// This is intentional: RegularGrid.lonMax = lonMin + dx×nx covers the
		// full circle. ICON: 0 + 0.125×2880 = 360. GFS: 0 + 0.25×1440 = 360.
		const iconData = wktToGridData(ICON_GLOBAL_WKT, 2880, 1441) as RegularGridData;
		const gfsData = wktToGridData(GFS_025_WKT, 1440, 721) as RegularGridData;

		const iconGrid = new RegularGrid(iconData);
		const gfsGrid = new RegularGrid(gfsData);

		expect(iconGrid.getBounds()[2]).toBe(360);
		expect(gfsGrid.getBounds()[2]).toBe(360);
	});

	test('global grids are detected as longitude-wrapping', () => {
		const iconData = wktToGridData(ICON_GLOBAL_WKT, 2880, 1441) as RegularGridData;
		const gfsData = wktToGridData(GFS_025_WKT, 1440, 721) as RegularGridData;

		const iconGrid = new RegularGrid(iconData);
		const gfsGrid = new RegularGrid(gfsData);

		// Both should cover ≥359.875°, triggering longitudeWrap
		const iconBounds = iconGrid.getBounds();
		const gfsBounds = gfsGrid.getBounds();
		expect(iconBounds[2] - iconBounds[0]).toBeGreaterThanOrEqual(359.875);
		expect(gfsBounds[2] - gfsBounds[0]).toBeGreaterThanOrEqual(359.875);
	});

	test('throws when BBOX is missing', () => {
		const wktNoBbox = `GEOGCRS["WGS 84",
            DATUM["World Geodetic System 1984",
                ELLIPSOID["WGS 84",6378137,298.257223563]],
            CS[ellipsoidal,2]]`;
		expect(() => wktToGridData(wktNoBbox, 100, 100)).toThrow('No BBOX found');
	});

	test('throws for unknown WKT type', () => {
		const unknownWkt = `UNKNOWNCRS["Foo", USAGE[SCOPE["grid"],BBOX[0,0,1,1]]]`;
		expect(() => wktToGridData(unknownWkt, 10, 10)).toThrow('Unknown WKT type');
	});
});

// ============================================================================
// wktToGridData – rotated lat/lon
// ============================================================================

describe('wktToGridData – rotated lat/lon', () => {
	test('KNMI: returns projectedFromBounds with RotatedLatLonProjection', () => {
		const grid = wktToGridData(KNMI_ROTATED_WKT, 676, 564) as ProjectionGridFromBounds;
		expect(grid.type).toBe('projectedFromBounds');
		expect(grid.nx).toBe(676);
		expect(grid.ny).toBe(564);
		expect(grid.projection.name).toBe('RotatedLatLonProjection');
	});

	test('KNMI: geographic bounds from BBOX', () => {
		const grid = wktToGridData(KNMI_ROTATED_WKT, 676, 564) as ProjectionGridFromBounds;
		expect(grid.latitudeBounds[0]).toBeCloseTo(39.740627, 6);
		expect(grid.latitudeBounds[1]).toBeCloseTo(62.619324, 6);
		expect(grid.longitudeBounds[0]).toBeCloseTo(-25.162262, 6);
		expect(grid.longitudeBounds[1]).toBeCloseTo(38.75702, 6);
	});

	test('KNMI: o_lat_p=35 → rotatedLat=35 (positive north-pole latitude)', () => {
		const grid = wktToGridData(KNMI_ROTATED_WKT, 676, 564) as ProjectionGridFromBounds;
		const proj = grid.projection as RotatedLatLonProjectionData;
		expect(proj.rotatedLat).toBe(35);
		expect(proj.rotatedLon).toBe(-8);
	});

	test('KNMI: projection θ = 55° (consistent with Swift RotatedLatLonProjection(latitude:-35))', () => {
		// Swift: θ = (90 + (-35))° = 55°
		// WKT:   o_lat_p = -(55-90) = 35
		// JS:    rotatedLat = 35  →  θ = 90 - 35 = 55°
		const grid = wktToGridData(KNMI_ROTATED_WKT, 676, 564) as ProjectionGridFromBounds;
		const proj = new RotatedLatLonProjection(grid.projection as RotatedLatLonProjectionData);
		expect(proj.θ).toBeCloseTo(Math.PI * 55 / 180, 10); // 55° in radians
		expect(proj.ϕ).toBeCloseTo(Math.PI * -8 / 180, 10); // -8° in radians
	});

	test('KNMI: forward/reverse round-trip', () => {
		const grid = wktToGridData(KNMI_ROTATED_WKT, 676, 564) as ProjectionGridFromBounds;
		const proj = new RotatedLatLonProjection(grid.projection as RotatedLatLonProjectionData);
		const [x, y] = proj.forward(39.671, -25.421997);
		const [lat, lon] = proj.reverse(x, y);
		expect(lat).toBeCloseTo(39.671, 5);
		expect(lon).toBeCloseTo(-25.421997, 5);
	});

	test('MeteoSwiss: o_lat_p=-43 (negative) → rotatedLat=-43', () => {
		// Verifies that negative o_lat_p is preserved with correct sign.
		const grid = wktToGridData(METEOSWISS_ROTATED_WKT, 710, 640) as ProjectionGridFromBounds;
		const proj = grid.projection as RotatedLatLonProjectionData;
		expect(proj.rotatedLat).toBe(-43);
		expect(proj.rotatedLon).toBe(190);
	});

	test('MeteoSwiss: θ = 133° (negative o_lat_p gives θ > 90°)', () => {
		// Swift: RotatedLatLonProjection(latitude: 43.0, longitude: 190.0)
		//   θ = (90 + 43)° = 133°  →  o_lat_p = -(133-90) = -43
		// JS: rotatedLat = -43  →  θ = 90 - (-43) = 133°
		// If the sign were wrong (negated), we'd get θ = 47° instead of 133°.
		const grid = wktToGridData(METEOSWISS_ROTATED_WKT, 710, 640) as ProjectionGridFromBounds;
		const proj = new RotatedLatLonProjection(grid.projection as RotatedLatLonProjectionData);
		expect(proj.θ).toBeCloseTo(Math.PI * 133 / 180, 10); // 133°, not 47°
		expect(proj.ϕ).toBeCloseTo(Math.PI * 190 / 180, 10);
	});

	test('MeteoSwiss: forward/reverse round-trip', () => {
		const grid = wktToGridData(METEOSWISS_ROTATED_WKT, 710, 640) as ProjectionGridFromBounds;
		const proj = new RotatedLatLonProjection(grid.projection as RotatedLatLonProjectionData);
		const testLat = 46.9;
		const testLon = 7.4;
		const [x, y] = proj.forward(testLat, testLon);
		const [lat, lon] = proj.reverse(x, y);
		expect(lat).toBeCloseTo(testLat, 5);
		expect(lon).toBeCloseTo(testLon, 5);
	});

	test('regular GEOGCRS (no DERIVINGCONVERSION) is parsed as regular grid', () => {
		// Smoke test: a plain GEOGCRS without DERIVINGCONVERSION must not be
		// misidentified as rotated lat/lon.
		const grid = wktToGridData(ICON_GLOBAL_WKT, 2880, 1441);
		expect(grid.type).toBe('regular');
	});
});

// ============================================================================
// wktToGridData – projected CRS (Stereographic)
// ============================================================================

describe('wktToGridData – Stereographic', () => {
	test('returns projectedFromBounds with StereographicProjection', () => {
		const grid = wktToGridData(STEREO_WKT, 1500, 1500) as ProjectionGridFromBounds;
		expect(grid.type).toBe('projectedFromBounds');
		expect(grid.projection.name).toBe('StereographicProjection');
	});

	test('latitude and longitude of natural origin', () => {
		const grid = wktToGridData(STEREO_WKT, 1500, 1500) as ProjectionGridFromBounds;
		expect(grid.projection.name).toBe('StereographicProjection');
		if (grid.projection.name === 'StereographicProjection') {
			expect(grid.projection.latitude).toBe(90);
			expect(grid.projection.longitude).toBe(0);
		}
	});

	test('ellipsoid radius extracted from ELLIPSOID', () => {
		const grid = wktToGridData(STEREO_WKT, 1500, 1500) as ProjectionGridFromBounds;
		if (grid.projection.name === 'StereographicProjection') {
			expect(grid.projection.radius).toBe(6371229);
		}
	});

	test('geographic bounds from BBOX', () => {
		const grid = wktToGridData(STEREO_WKT, 1500, 1500) as ProjectionGridFromBounds;
		expect(grid.latitudeBounds[0]).toBe(56);
		expect(grid.latitudeBounds[1]).toBe(90);
		expect(grid.longitudeBounds[0]).toBe(-120);
		expect(grid.longitudeBounds[1]).toBe(120);
	});

	test('dimensions preserved', () => {
		const grid = wktToGridData(STEREO_WKT, 1500, 1500) as ProjectionGridFromBounds;
		expect(grid.nx).toBe(1500);
		expect(grid.ny).toBe(1500);
	});

	test('throws for unrecognised PROJCRS method', () => {
		const badWkt = `PROJCRS["Unknown",
            BASEGEOGCRS["GCS_Sphere",DATUM["D",ELLIPSOID["S",6371229,0]]],
            CONVERSION["Unknown",METHOD["Mystery Projection"]],
            CS[Cartesian,2],AXIS["e",east],AXIS["n",north],LENGTHUNIT["m",1],
            USAGE[SCOPE["grid"],BBOX[0,0,90,90]]]`;
		expect(() => wktToGridData(badWkt, 100, 100)).toThrow('Unknown projection method');
	});
});

// ============================================================================
// wktToGridData – Lambert Conformal Conic
// ============================================================================

describe('wktToGridData – Lambert Conformal Conic', () => {
	test('returns projectedFromBounds with LambertConformalConicProjection', () => {
		const grid = wktToGridData(LCC_WKT, 1906, 1606) as ProjectionGridFromBounds;
		expect(grid.type).toBe('projectedFromBounds');
		expect(grid.projection.name).toBe('LambertConformalConicProjection');
	});

	test('standard parallels and reference latitude/longitude', () => {
		const grid = wktToGridData(LCC_WKT, 1906, 1606) as ProjectionGridFromBounds;
		if (grid.projection.name === 'LambertConformalConicProjection') {
			expect(grid.projection.ϕ1).toBe(55.5);
			expect(grid.projection.ϕ2).toBe(55.5);
			expect(grid.projection.ϕ0).toBe(55.5);
			expect(grid.projection.λ0).toBe(352);
		}
	});

	test('ellipsoid radius extracted', () => {
		const grid = wktToGridData(LCC_WKT, 1906, 1606) as ProjectionGridFromBounds;
		if (grid.projection.name === 'LambertConformalConicProjection') {
			expect(grid.projection.radius).toBe(6371229);
		}
	});

	test('geographic bounds from BBOX', () => {
		const grid = wktToGridData(LCC_WKT, 1906, 1606) as ProjectionGridFromBounds;
		expect(grid.latitudeBounds[0]).toBeCloseTo(39.671, 3);
		expect(grid.longitudeBounds[0]).toBeCloseTo(-25.421997, 6);
	});

	test('alternate method name "Lambert_Conformal_Conic" also parsed', () => {
		const altWkt = LCC_WKT.replace('Lambert Conic Conformal (2SP)', 'Lambert_Conformal_Conic');
		const grid = wktToGridData(altWkt, 1906, 1606) as ProjectionGridFromBounds;
		expect(grid.projection.name).toBe('LambertConformalConicProjection');
	});
});

// ============================================================================
// wktToGridData – Lambert Azimuthal Equal-Area
// ============================================================================

describe('wktToGridData – Lambert Azimuthal Equal-Area', () => {
	test('returns projectedFromBounds with LambertAzimuthalEqualAreaProjection', () => {
		const grid = wktToGridData(LAEA_WKT, 600, 600) as ProjectionGridFromBounds;
		expect(grid.type).toBe('projectedFromBounds');
		expect(grid.projection.name).toBe('LambertAzimuthalEqualAreaProjection');
	});

	test('natural origin latitude and longitude', () => {
		const grid = wktToGridData(LAEA_WKT, 600, 600) as ProjectionGridFromBounds;
		if (grid.projection.name === 'LambertAzimuthalEqualAreaProjection') {
			expect(grid.projection.ϕ1).toBe(52);
			expect(grid.projection.λ0).toBe(10);
		}
	});

	test('ellipsoid radius extracted', () => {
		const grid = wktToGridData(LAEA_WKT, 600, 600) as ProjectionGridFromBounds;
		if (grid.projection.name === 'LambertAzimuthalEqualAreaProjection') {
			expect(grid.projection.radius).toBe(6371229);
		}
	});

	test('geographic bounds from BBOX', () => {
		const grid = wktToGridData(LAEA_WKT, 600, 600) as ProjectionGridFromBounds;
		expect(grid.latitudeBounds).toEqual([29, 73]);
		expect(grid.longitudeBounds).toEqual([-23, 45]);
	});

	test('alternate method name "Lambert_Azimuthal_Equal_Area" also parsed', () => {
		const altWkt = LAEA_WKT.replace('Lambert Azimuthal Equal-Area', 'Lambert_Azimuthal_Equal_Area');
		// Replace both occurrences (method name and CRS name), ensure at least the
		// conversion METHOD name is replaced:
		const grid = wktToGridData(
			LAEA_WKT.replace(
				'METHOD["Lambert Azimuthal Equal-Area"]',
				'METHOD["Lambert_Azimuthal_Equal_Area"]'
			),
			600,
			600
		) as ProjectionGridFromBounds;
		expect(grid.projection.name).toBe('LambertAzimuthalEqualAreaProjection');
	});
});

// ============================================================================
// wktToGridData – Gaussian grids
// ============================================================================

describe('wktToGridData – Gaussian grids', () => {
	test('O1280: returns gaussian type with correct latitude lines', () => {
		const grid = wktToGridData(GAUSSIAN_O1280_WKT, 5136, 2560) as GaussianGridData;
		expect(grid.type).toBe('gaussian');
		expect(grid.gaussianGridLatitudeLines).toBe(1280);
	});

	test('O1280: dimensions preserved', () => {
		const grid = wktToGridData(GAUSSIAN_O1280_WKT, 5136, 2560) as GaussianGridData;
		expect(grid.nx).toBe(5136);
		expect(grid.ny).toBe(2560);
	});

	test('O320: gaussianGridLatitudeLines = 320', () => {
		const grid = wktToGridData(GAUSSIAN_O320_WKT, 1280, 640) as GaussianGridData;
		expect(grid.type).toBe('gaussian');
		expect(grid.gaussianGridLatitudeLines).toBe(320);
	});

	test('missing O/N number falls back to ny/2', () => {
		const noNumberWkt = GAUSSIAN_O1280_WKT.replace(
			'Reduced Gaussian Grid O1280 (ECMWF)',
			'Reduced Gaussian Grid (ECMWF)'
		);
		const grid = wktToGridData(noNumberWkt, 5136, 2560) as GaussianGridData;
		expect(grid.gaussianGridLatitudeLines).toBe(2560 / 2);
	});
});
