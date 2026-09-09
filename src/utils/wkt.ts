import type {
	GaussianGridData,
	GridData,
	ProjectionGridFromBounds,
	RegularGridFromBounds
} from '../types';

type WktValue = string | number | WktNode | WktValue[];

interface WktNode {
	type: string;
	values: WktValue[];
	children: Record<string, WktNode[]>;
}

function tokenizeWkt(wkt: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	const len = wkt.length;

	while (i < len) {
		const ch = wkt[i];

		// Skip whitespace
		if (/\s/.test(ch)) {
			i++;
			continue;
		}

		// Single-character tokens
		if (ch === '[' || ch === ']' || ch === ',') {
			tokens.push(ch);
			i++;
			continue;
		}

		// Quoted string
		if (ch === '"') {
			let str = '';
			i++; // skip opening quote
			while (i < len && wkt[i] !== '"') {
				str += wkt[i];
				i++;
			}
			i++; // skip closing quote
			tokens.push(`"${str}"`);
			continue;
		}

		// Identifier or number
		let token = '';
		while (i < len && !/[[\],\s"]/.test(wkt[i])) {
			token += wkt[i];
			i++;
		}
		if (token) {
			tokens.push(token);
		}
	}

	return tokens;
}

function parseWktTokens(tokens: string[], pos: { i: number }): WktNode {
	const typeName = tokens[pos.i++];
	if (tokens[pos.i] !== '[') {
		throw new Error(`Expected '[' after ${typeName}, got ${tokens[pos.i]}`);
	}
	pos.i++; // skip '['

	const values: WktValue[] = [];
	const children: Record<string, WktNode[]> = {};

	while (pos.i < tokens.length && tokens[pos.i] !== ']') {
		const token = tokens[pos.i];

		if (token === ',') {
			pos.i++;
			continue;
		}

		// Check if this is a nested node (identifier followed by '[')
		if (pos.i + 1 < tokens.length && tokens[pos.i + 1] === '[') {
			const child = parseWktTokens(tokens, pos);
			if (!children[child.type]) {
				children[child.type] = [];
			}
			children[child.type].push(child);
		} else {
			// It's a value (string, number, or identifier)
			let value: WktValue;
			if (token.startsWith('"')) {
				value = token.slice(1, -1); // remove quotes
			} else if (!isNaN(Number(token))) {
				value = Number(token);
			} else {
				value = token; // identifier like 'north', 'east', 'ellipsoidal'
			}
			values.push(value);
			pos.i++;
		}
	}

	pos.i++; // skip ']'

	return { type: typeName, values, children };
}

export function parseWkt(wkt: string): WktNode {
	const tokens = tokenizeWkt(wkt);
	const pos = { i: 0 };
	return parseWktTokens(tokens, pos);
}

// ============================================================================
// Helper functions to extract data from parsed WKT
// ============================================================================

function getChild(node: WktNode, ...path: string[]): WktNode | undefined {
	let current: WktNode | undefined = node;
	for (const key of path) {
		if (!current?.children[key]?.[0]) return undefined;
		current = current.children[key][0];
	}
	return current;
}

function getParameter(node: WktNode, paramName: string): number | undefined {
	const params = node.children['PARAMETER'] || [];
	for (const p of params) {
		if (p.values[0] === paramName && typeof p.values[1] === 'number') {
			return p.values[1];
		}
	}
	return undefined;
}

/**
 * The open-meteo server writes `BBOX[latMin, lonMin, latMax, lonMax]` as the
 * geographic position of the first (index 0) and the last (nx*ny-1) grid
 * point, not as an extent. For a grid stored north to south "latMin" is
 * therefore the northern edge; callers keep that first/last order.
 */
function getBbox(
	node: WktNode
): { latMin: number; lonMin: number; latMax: number; lonMax: number } | undefined {
	const usage = node.children['USAGE']?.[0];
	if (!usage) return undefined;

	const bbox = usage.children['BBOX']?.[0];
	if (!bbox) return undefined;

	const v = bbox.values;
	if (v.length >= 4 && v.every((x) => typeof x === 'number')) {
		return {
			latMin: v[0] as number,
			lonMin: v[1] as number,
			latMax: v[2] as number,
			lonMax: v[3] as number
		};
	}
	return undefined;
}

function getEllipsoidRadius(node: WktNode): number | undefined {
	// Try different paths to find ELLIPSOID
	const paths = [
		['DATUM', 'ELLIPSOID'],
		['BASEGEOGCRS', 'DATUM', 'ELLIPSOID']
	];

	for (const path of paths) {
		const ellipsoid = getChild(node, ...path);
		if (ellipsoid && typeof ellipsoid.values[1] === 'number') {
			return ellipsoid.values[1];
		}
	}
	return undefined;
}

function getRemark(node: WktNode): string | undefined {
	const remark = node.children['REMARK']?.[0];
	if (remark && typeof remark.values[0] === 'string') {
		return remark.values[0];
	}
	return undefined;
}

// ============================================================================
// Convert parsed WKT to GridData
// ============================================================================

/**
 * Derive the grid definition of an om file from its `crs_wkt` attribute (OGC
 * WKT2 as written by the open-meteo server) and the dimensions of a variable.
 */
export function wktToGridData(wkt: string, nx: number, ny: number): GridData {
	const parsed = parseWkt(wkt);
	const bbox = getBbox(parsed);

	if (!bbox) {
		throw new Error('No BBOX found in WKT USAGE section');
	}

	// Reduced Gaussian grids have no real CRS; the server tags them in REMARK,
	// e.g. "Reduced Gaussian Grid O1280 (ECMWF)".
	const remark = getRemark(parsed);
	if (remark && remark.includes('Reduced Gaussian Grid')) {
		return gaussianGridData(remark, nx, ny);
	}

	// Check if it's a projected CRS
	if (parsed.type === 'PROJCRS') {
		const conversion = parsed.children['CONVERSION']?.[0];
		if (!conversion) {
			throw new Error('PROJCRS missing CONVERSION');
		}

		const method = conversion.children['METHOD']?.[0];
		const methodName = method?.values[0] as string;
		const radius = getEllipsoidRadius(parsed);
		const bounds: Pick<ProjectionGridFromBounds, 'type' | 'nx' | 'ny' | 'latitude' | 'longitude'> =
			{
				type: 'projectedFromBounds',
				nx,
				ny,
				latitude: [bbox.latMin, bbox.latMax],
				longitude: [bbox.lonMin, bbox.lonMax]
			};

		// Stereographic
		if (methodName?.includes('Stereographic')) {
			const lat = getParameter(conversion, 'Latitude of natural origin') ?? 90;
			const lon = getParameter(conversion, 'Longitude of natural origin') ?? 0;

			return {
				...bounds,
				projection: {
					name: 'StereographicProjection',
					latitude: lat,
					longitude: lon,
					...(radius && { radius })
				}
			};
		}

		// Lambert Conformal Conic
		if (
			methodName?.includes('Lambert Conic Conformal') ||
			methodName?.includes('Lambert_Conformal_Conic')
		) {
			const phi1 =
				getParameter(conversion, 'Latitude of 1st standard parallel') ??
				getParameter(conversion, 'Latitude of false origin') ??
				0;
			const phi2 = getParameter(conversion, 'Latitude of 2nd standard parallel') ?? phi1;
			const phi0 = getParameter(conversion, 'Latitude of false origin') ?? phi1;
			const lambda0 =
				getParameter(conversion, 'Longitude of false origin') ??
				getParameter(conversion, 'Longitude of natural origin') ??
				0;

			return {
				...bounds,
				projection: {
					name: 'LambertConformalConicProjection',
					λ0: lambda0,
					ϕ0: phi0,
					ϕ1: phi1,
					ϕ2: phi2,
					...(radius && { radius })
				}
			};
		}

		// Lambert Azimuthal Equal-Area
		if (
			methodName?.includes('Lambert Azimuthal Equal-Area') ||
			methodName?.includes('Lambert_Azimuthal_Equal_Area')
		) {
			const lat = getParameter(conversion, 'Latitude of natural origin') ?? 0;
			const lon = getParameter(conversion, 'Longitude of natural origin') ?? 0;

			return {
				...bounds,
				projection: {
					name: 'LambertAzimuthalEqualAreaProjection',
					λ0: lon,
					ϕ1: lat,
					radius: radius ?? 6371229
				}
			};
		}

		throw new Error(`Unknown projection method: ${methodName}`);
	}

	// Check for Rotated Lat/Lon (GEOGCRS with DERIVINGCONVERSION)
	if (parsed.type === 'GEOGCRS') {
		const derivingConversion = parsed.children['DERIVINGCONVERSION']?.[0];

		if (derivingConversion) {
			const oLatP = getParameter(derivingConversion, 'o_lat_p') ?? 0;
			const lon0 = getParameter(derivingConversion, 'lon_0') ?? 0;

			// The server writes o_lat_p = 90 - θ (RotatedLatLon.swift) while
			// RotatedLatLonProjection derives θ = 90 + rotatedLat, so the pole
			// latitude changes sign on the way in: o_lat_p = 35 → rotatedLat = -35.
			return {
				type: 'projectedFromBounds',
				projection: {
					name: 'RotatedLatLonProjection',
					rotatedLat: -oLatP,
					rotatedLon: lon0
				},
				nx,
				ny,
				latitude: [bbox.latMin, bbox.latMax],
				longitude: [bbox.lonMin, bbox.lonMax]
			};
		}

		// Regular lat/lon grid, defined by its first and last grid point so the
		// spacing is derived exactly like the server does: (last - first) / (n - 1).
		// A grid stored north to south has latMin > latMax, which gives the
		// negative row spacing RegularGrid expects for such grids.
		let lonMax = bbox.lonMax;
		// A grid crossing the antimeridian ends at a smaller longitude than it starts.
		if (lonMax < bbox.lonMin) lonMax += 360;

		const grid: RegularGridFromBounds = {
			type: 'regular',
			nx,
			ny,
			latitude: [bbox.latMin, bbox.latMax],
			longitude: [bbox.lonMin, lonMax]
		};
		return grid;
	}

	throw new Error(`Unknown WKT type: ${parsed.type}`);
}

function gaussianGridData(remark: string, nx: number, ny: number): GaussianGridData {
	if (/\bArea\b/.test(remark)) {
		throw new Error(`Regional reduced Gaussian grids are not supported: ${remark}`);
	}
	// GaussianGrid implements the octahedral layout (O<n>: 20 + 4i points on the
	// i-th latitude line from the pole); classic reduced grids (N<n>) lay out
	// their lines differently and would be misplaced.
	const match = remark.match(/\bO(\d+)\b/);
	if (!match) {
		throw new Error(`Only octahedral reduced Gaussian grids (O<n>) are supported: ${remark}`);
	}

	return {
		type: 'gaussian',
		nx,
		ny,
		gaussianGridLatitudeLines: parseInt(match[1], 10)
	};
}
