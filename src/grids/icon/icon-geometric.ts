import { IconGrid } from './icon';

// The purely geometric ICON grid — the raw analytical construction with NO
// spring-dynamics correction (neither the embedded warp table of grids/icon.ts
// nor the polynomial model of icon-analytical.ts). Cell ordering and topology
// match the operational DWD grids exactly, but positions are the idealized
// icosahedral subdivision: recursive spherical bisection with equal-arc root
// edges, cell centre = spherical circumcenter of the leaf triangle.
//
// Deviation from the operational grids (the spring-dynamics warp): ~21 km mean
// / 65 km max for the R3 family (R3B06/R3B07), ~36 km mean / 93 km max for
// R2B06 — largest towards the 12 pentagon points. Rendered fields are warped
// by about one cell width but stay locally consistent (findCell and
// cellCoordinates are exact inverses of each other).
//
// Kept as the zero-data baseline and for comparison/debugging — the maps
// /grid-compare page overlays it against the actual grid and the corrected
// implementations.
export class IconGridGeometric extends IconGrid {
	protected override lookupWarpTable(): undefined {
		return undefined;
	}
}
