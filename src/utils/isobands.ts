import { GridInterface } from '../grids/index';
import Pbf from 'pbf';

import { type ResolvedClippingOptions, createClippingTester } from './clipping';
import { VECTOR_TILE_EXTENT } from './constants';
import { tile2lat, tile2lon } from './math';
import { command, writeLayer, zigzag } from './pbf';
import { getColor } from './styling';

import type { RenderableColorScale } from '../types';

/**
 * Isoband case table for marching squares with two thresholds.
 *
 * Each cell corner is classified as:
 *   0 = below lower threshold
 *   1 = between lower and upper threshold (inside the band)
 *   2 = above upper threshold
 *
 * Corner ordering: TL, TR, BR, BL (ternary: TL*27 + TR*9 + BR*3 + BL)
 *
 * Edge midpoints (with interpolation):
 *   T = top edge, R = right edge, B = bottom edge, L = left edge
 *   Suffixed with L(o) or H(i) for which threshold to interpolate against.
 *
 * Each case entry is an array of polygon rings. Each ring is an ordered list of
 * edge-point identifiers that trace the boundary of the band region within the cell.
 *
 * Edge encoding: [edge, threshold]
 *   edge: 0=left, 1=top, 2=right, 3=bottom
 *   threshold: 0=lower, 1=upper
 *   Special: 'TL','TR','BR','BL' = cell corner (inside the band, value=1)
 */

// Point types for ring construction
type EdgePoint = [number, number]; // [edge(0-3), threshold(0-1)]
type CornerPoint = string; // 'TL' | 'TR' | 'BR' | 'BL'
type RingPoint = EdgePoint | CornerPoint;
type CaseRings = RingPoint[][];

// Build the 81-entry case table for isobands.
// Each corner: 0=below, 1=in-band, 2=above
// Index = TL*27 + TR*9 + BR*3 + BL
const ISOBAND_CASES: CaseRings[] = buildCaseTable();

function buildCaseTable(): CaseRings[] {
	const table: CaseRings[] = new Array(81);

	// Enumerate all 81 combinations
	for (let tl = 0; tl < 3; tl++) {
		for (let tr = 0; tr < 3; tr++) {
			for (let br = 0; br < 3; br++) {
				for (let bl = 0; bl < 3; bl++) {
					const idx = tl * 27 + tr * 9 + br * 3 + bl;
					table[idx] = computeCase(tl, tr, br, bl);
				}
			}
		}
	}
	return table;
}

function computeCase(tl: number, tr: number, br: number, bl: number): CaseRings {
	// For each cell, we need to find the region(s) where all corners are "in-band" (=1).
	// This uses a direct enumeration approach.
	// If all corners are 0 or all are 2, no band region exists → empty.
	// If all corners are 1, the entire cell is in the band → full quad.

	// const code = tl * 27 + tr * 9 + br * 3 + bl;

	// All same → no band or full band
	if (tl === 0 && tr === 0 && br === 0 && bl === 0) return []; // all below
	if (tl === 2 && tr === 2 && br === 2 && bl === 2) return []; // all above
	if (tl === 1 && tr === 1 && br === 1 && bl === 1) {
		// Full cell is in band
		return [['TL', 'TR', 'BR', 'BL']];
	}

	// Build the band polygon by tracing the cell boundary and threshold crossings.
	// Walk around the cell edges (L→T→R→B) and collect points where:
	// - we cross a threshold (interpolated edge point)
	// - a corner is inside the band (corner point)
	// Between these points, we're either inside or outside the band.
	const ring = traceRing(tl, tr, br, bl);
	if (ring.length === 0) return [];

	// Check for saddle-point ambiguity (cases where two separate band regions exist)
	// This happens when diagonally opposite corners are in-band and the other two are not,
	// OR when we have mixed 0/2 on opposite corners with 1s mixed in certain ways.
	if (isSaddleCase(tl, tr, br, bl)) {
		const rings = traceSaddleRings(tl, tr, br, bl);
		return rings;
	}

	return [ring];
}

function isSaddleCase(tl: number, tr: number, br: number, bl: number): boolean {
	// Diagonal in-band corners with matching out-of-band corners
	if (tl === 1 && br === 1 && tr === bl && (tr === 0 || tr === 2)) return true;
	if (tr === 1 && bl === 1 && tl === br && (tl === 0 || tl === 2)) return true;
	// Diagonal 0-2 pattern with no in-band corners: band forms two disconnected strips
	if (tl === 0 && tr === 2 && br === 0 && bl === 2) return true;
	if (tl === 2 && tr === 0 && br === 2 && bl === 0) return true;
	return false;
}

function traceSaddleRings(tl: number, tr: number, br: number, bl: number): CaseRings {
	// Two separate band regions exist
	if (tl === 1 && br === 1) {
		// TL and BR are in-band, TR and BL are out (same value)
		const out = tr; // = bl, either 0 or 2
		const tIdx = out === 0 ? 0 : 1; // threshold index for interpolation

		return [
			// Ring around TL corner
			['TL', [1, tIdx], [0, tIdx]],
			// Ring around BR corner
			['BR', [3, tIdx], [2, tIdx]]
		];
	}
	if (tr === 1 && bl === 1) {
		// TR and BL are in-band, TL and BR are out
		const out = tl; // = br, either 0 or 2
		const tIdx = out === 0 ? 0 : 1;

		return [
			// Ring around TR corner
			['TR', [2, tIdx], [1, tIdx]],
			// Ring around BL corner
			['BL', [0, tIdx], [3, tIdx]]
		];
	}
	// 0-2-0-2: band strips near TL and BR corners
	// Each strip is bounded by lo and hi crossings on the two adjacent edges
	if (tl === 0 && tr === 2 && br === 0 && bl === 2) {
		return [
			// TL strip: left-hi → left-lo → top-lo → top-hi (CW in screen coords)
			[
				[0, 1],
				[0, 0],
				[1, 0],
				[1, 1]
			],
			// BR strip: right-hi → right-lo → bottom-lo → bottom-hi
			[
				[2, 1],
				[2, 0],
				[3, 0],
				[3, 1]
			]
		];
	}
	// 2-0-2-0: band strips near TR and BL corners
	if (tl === 2 && tr === 0 && br === 2 && bl === 0) {
		return [
			// TR strip: top-hi → top-lo → right-lo → right-hi
			[
				[1, 1],
				[1, 0],
				[2, 0],
				[2, 1]
			],
			// BL strip: bottom-hi → bottom-lo → left-lo → left-hi
			[
				[3, 1],
				[3, 0],
				[0, 0],
				[0, 1]
			]
		];
	}
	return [];
}

function traceRing(tl: number, tr: number, br: number, bl: number): RingPoint[] {
	// Walk around the cell boundary collecting band-region boundary points.
	// Edges: Left (BL→TL), Top (TL→TR), Right (TR→BR), Bottom (BR→BL)
	const points: RingPoint[] = [];

	// Left edge: BL → TL
	addEdgePoints(points, bl, tl, 0);
	// Corner TL
	if (tl === 1) points.push('TL');
	// Top edge: TL → TR
	addEdgePoints(points, tl, tr, 1);
	// Corner TR
	if (tr === 1) points.push('TR');
	// Right edge: TR → BR
	addEdgePoints(points, tr, br, 2);
	// Corner BR
	if (br === 1) points.push('BR');
	// Bottom edge: BR → BL
	addEdgePoints(points, br, bl, 3);
	// Corner BL
	if (bl === 1) points.push('BL');

	// Filter: need at least 3 points for a polygon
	if (points.length < 3) return [];

	return points;
}

function addEdgePoints(points: RingPoint[], from: number, to: number, edge: number): void {
	// Add interpolation points for crossings along an edge
	// from/to are the ternary values at the start/end of the edge
	if (from === to) return; // no crossing

	if (from === 0 && to === 1) {
		points.push([edge, 0]); // lower threshold crossing
	} else if (from === 1 && to === 0) {
		points.push([edge, 0]); // lower threshold crossing
	} else if (from === 1 && to === 2) {
		points.push([edge, 1]); // upper threshold crossing
	} else if (from === 2 && to === 1) {
		points.push([edge, 1]); // upper threshold crossing
	} else if (from === 0 && to === 2) {
		points.push([edge, 0]); // lower threshold crossing
		points.push([edge, 1]); // upper threshold crossing
	} else if (from === 2 && to === 0) {
		points.push([edge, 1]); // upper threshold crossing
		points.push([edge, 0]); // lower threshold crossing
	}
}

/**
 * Generates filled isoband polygons using marching squares with interpolated edges.
 * Produces smooth band boundaries identical to the contour algorithm's line placement.
 * Each band between adjacent color scale thresholds becomes a polygon feature.
 *
 * Uses a reduced resolution grid (256×256) for performance — the underlying weather
 * data is coarser than this, so interpolated boundaries remain smooth.
 */
export const generateIsobands = (
	pbf: Pbf,
	values: Float32Array,
	grid: GridInterface,
	x: number,
	y: number,
	z: number,
	tileSize: number,
	colorScale: RenderableColorScale,
	clippingOptions: ResolvedClippingOptions | undefined,
	extent: number = VECTOR_TILE_EXTENT
) => {
	// Reduce resolution: 256 cells per side regardless of tileSize.
	// Weather data is coarser than this; marching-squares interpolation keeps edges smooth.
	const resolution = 256;
	const step = tileSize / resolution;
	const multiplier = extent / resolution;
	const buffer = 1;

	const isInsideClip = createClippingTester(clippingOptions);

	// Get sorted thresholds from color scale
	const thresholds = getThresholds(colorScale);
	if (thresholds.length === 0) return;

	// Pre-sample grid values at reduced resolution
	const cols = resolution + 2 * buffer;
	const rows = resolution + 2 * buffer;
	const w = cols + 1;
	const h = rows + 1;
	const sampled = new Float32Array(w * h);

	for (let row = 0; row < h; row++) {
		const gridRow = (row - buffer) * step;
		const lat = tile2lat(y + gridRow / tileSize, z);
		for (let col = 0; col < w; col++) {
			const gridCol = (col - buffer) * step;
			const lon = tile2lon(x + gridCol / tileSize, z);
			sampled[row * w + col] = grid.getLinearInterpolatedValue(values, lat, lon);
		}
	}

	// Pre-classify all sampled values against all thresholds.
	// classifications[tIdx][row * w + col] = 0 (below), 1 (in-band), or 2 (above)
	// Band tIdx spans [thresholds[tIdx-1], thresholds[tIdx]) for tIdx > 0,
	// [-Inf, thresholds[0]) for tIdx=0, [thresholds[last], +Inf) for tIdx=numBands-1.
	const numBands = thresholds.length + 1;
	const bandThresholds: { lo: number; hi: number }[] = [];
	bandThresholds.push({ lo: -Infinity, hi: thresholds[0] });
	for (let t = 0; t < thresholds.length - 1; t++) {
		bandThresholds.push({ lo: thresholds[t], hi: thresholds[t + 1] });
	}
	bandThresholds.push({ lo: thresholds[thresholds.length - 1], hi: Infinity });

	// For each band, collect polygon rings
	const bandGeoms: Map<number, number[]> = new Map();

	for (let bandIdx = 0; bandIdx < numBands; bandIdx++) {
		const { lo, hi } = bandThresholds[bandIdx];
		const geom: number[] = [];
		let cursorX = 0;
		let cursorY = 0;

		for (let row = 1; row < h; row++) {
			for (let col = 1; col < w; col++) {
				// Grid cell corners: TL, TR, BR, BL
				const tld = sampled[(row - 1) * w + (col - 1)];
				const trd = sampled[(row - 1) * w + col];
				const brd = sampled[row * w + col];
				const bld = sampled[row * w + (col - 1)];

				if (isNaN(tld) || isNaN(trd) || isNaN(brd) || isNaN(bld)) continue;

				// Map back to tile space for clipping check
				if (isInsideClip) {
					const lon = tile2lon(x + ((col - 1) * step) / tileSize, z);
					const lat = tile2lat(y + ((row - 1) * step) / tileSize, z);
					if (!isInsideClip(lon, lat)) continue;
				}

				const ctld = classify(tld, lo, hi);
				const ctrd = classify(trd, lo, hi);
				const cbrd = classify(brd, lo, hi);
				const cbld = classify(bld, lo, hi);

				const caseIdx = ctld * 27 + ctrd * 9 + cbrd * 3 + cbld;
				const caseRings = ISOBAND_CASES[caseIdx];
				if (caseRings.length === 0) continue;

				// Use contour coordinate system: cell (j, i) spans (j-1)*m to j*m
				// Sample at col corresponds to contour column col-buffer = col-1
				// So j = col - buffer = col - 1, but contour convention has cell
				// right edge at j, so j = col - buffer
				const cellJ = col - buffer;
				const cellI = row - buffer;

				for (const ringDef of caseRings) {
					const startGeomLen = geom.length;
					let ringPointCount = 0;

					for (const pt of ringDef) {
						let px: number, py: number;
						if (typeof pt === 'string') {
							[px, py] = cornerCoord(pt, cellJ, cellI, multiplier);
						} else {
							const [edge, tIdx] = pt;
							const threshold = tIdx === 0 ? lo : hi;
							[px, py] = edgeInterpolate(
								edge,
								cellJ,
								cellI,
								threshold,
								multiplier,
								bld,
								tld,
								brd,
								trd
							);
						}

						const rx = Math.round(px);
						const ry = Math.round(py);

						if (ringPointCount === 0) {
							geom.push(command(1, 1));
							geom.push(zigzag(rx - cursorX));
							geom.push(zigzag(ry - cursorY));
						} else if (ringPointCount === 1) {
							// We'll patch the LineTo count after we know the ring size
							geom.push(0); // placeholder for LineTo command
							geom.push(zigzag(rx - cursorX));
							geom.push(zigzag(ry - cursorY));
						} else {
							geom.push(zigzag(rx - cursorX));
							geom.push(zigzag(ry - cursorY));
						}
						cursorX = rx;
						cursorY = ry;
						ringPointCount++;
					}

					if (ringPointCount >= 3) {
						// Patch the LineTo command with the actual count
						geom[startGeomLen + 3] = command(2, ringPointCount - 1);
						// ClosePath
						geom.push(command(7, 1));
					} else {
						// Not enough points, roll back
						geom.length = startGeomLen;
					}
				}
			}
		}

		if (geom.length > 0) {
			bandGeoms.set(bandIdx, geom);
		}
	}

	// Emit features
	const features: {
		id: number;
		type: number;
		properties: Record<string, unknown>;
		geom: number[];
	}[] = [];

	for (const [bandIdx, geom] of bandGeoms) {
		const color = getBandColor(bandIdx, thresholds, colorScale);
		const [r, g, b, a] = color;

		features.push({
			id: 2000000 + bandIdx,
			type: 3, // Polygon
			properties: { r, g, b, a: Math.round(a * 255) },
			geom
		});
	}

	pbf.writeMessage(3, writeLayer, {
		name: 'isobands',
		extent,
		features
	});
};

function classify(value: number, lo: number, hi: number): number {
	if (value < lo) return 0;
	if (value >= hi) return 2;
	return 1;
}

function cornerCoord(corner: string, j: number, i: number, multiplier: number): [number, number] {
	// Matches contour coordinate system: cell (j, i) spans from
	// (j-1)*m to j*m in x, (i-1)*m to i*m in y
	switch (corner) {
		case 'TL':
			return [multiplier * (j - 1), multiplier * (i - 1)];
		case 'TR':
			return [multiplier * j, multiplier * (i - 1)];
		case 'BR':
			return [multiplier * j, multiplier * i];
		case 'BL':
			return [multiplier * (j - 1), multiplier * i];
		default:
			return [0, 0];
	}
}

function edgeInterpolate(
	edge: number,
	j: number,
	i: number,
	threshold: number,
	multiplier: number,
	bld: number,
	tld: number,
	brd: number,
	trd: number
): [number, number] {
	// Exact same interpolation as contours.ts interpolate()
	// Edge 0 = left:   x = (j-1)*m, y interpolated between i (bld) and i-1 (tld)
	// Edge 1 = top:    y = (i-1)*m, x interpolated between j (trd) and j-1 (tld)
	// Edge 2 = right:  x = j*m,     y interpolated between i (brd) and i-1 (trd)
	// Edge 3 = bottom: y = i*m,     x interpolated between j (brd) and j-1 (bld)
	const r = (a: number, b: number, c: number) => (b - a) / (c - a);

	switch (edge) {
		case 0: // left
			return [multiplier * (j - 1), multiplier * (i - r(bld, threshold, tld))];
		case 1: // top
			return [multiplier * (j - r(trd, threshold, tld)), multiplier * (i - 1)];
		case 2: // right
			return [multiplier * j, multiplier * (i - r(brd, threshold, trd))];
		case 3: // bottom
			return [multiplier * (j - r(brd, threshold, bld)), multiplier * i];
		default:
			return [0, 0];
	}
}

function getThresholds(colorScale: RenderableColorScale): number[] {
	switch (colorScale.type) {
		case 'breakpoint':
			return colorScale.breakpoints;
		case 'rgba': {
			const n = colorScale.colors.length;
			const delta = (colorScale.max - colorScale.min) / n;
			const thresholds: number[] = [];
			for (let i = 0; i < n; i++) {
				thresholds.push(colorScale.min + i * delta);
			}
			return thresholds;
		}
	}
}

function getBandColor(
	bandIdx: number,
	thresholds: number[],
	colorScale: RenderableColorScale
): [number, number, number, number] {
	// Get a representative value for this band index
	let value: number;
	if (bandIdx <= 0) {
		value = thresholds[0] - 1;
	} else if (bandIdx >= thresholds.length) {
		value = thresholds[thresholds.length - 1] + 1;
	} else {
		value = (thresholds[bandIdx - 1] + thresholds[bandIdx]) / 2;
	}
	return getColor(colorScale, value);
}
