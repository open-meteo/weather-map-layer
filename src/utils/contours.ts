import { PbfWriter } from 'pbf';

import { type ResolvedClippingOptions, createClippingTester } from './clipping';
import { VECTOR_TILE_EXTENT } from './constants';
import { tile2lat, tile2lon } from './math';
import { command, writeLayer, zigzag } from './pbf';
import type { ValueSampler } from './seamless-sampling';

// prettier-ignore
export const CASES: [number, number][][][] = [
	[],					       			// 0
	[[[1, 2],[0, 1]]],			  // 1
	[[[2, 1],[1, 2]]],			  // 2
	[[[2, 1],[0, 1]]],			  // 3
	[[[1, 0],[2, 1]]],			  // 4
	[[[1, 2],[0, 1]], [[1, 0],[2, 1]]],  // 5
	[[[1, 0],[1, 2]]],			  // 6
	[[[1, 0],[0, 1]]],			  // 7
	[[[0, 1],[1, 0]]],			  // 8
	[[[1, 2],[1, 0]]],			  // 9
	[[[0, 1],[1, 0]],[[2, 1],[1, 2]]],   // 10
	[[[2, 1],[1, 0]]],			  // 11
	[[[0, 1],[2, 1]]],			  // 12
	[[[1, 2],[2, 1]]],			  // 13
	[[[0, 1],[1, 2]]],			  // 14
	[]					       // 15
];

export class Fragment {
	start: number;
	end: number;
	points: number[];

	constructor(start: number, end: number) {
		this.start = start;
		this.end = end;
		this.points = [];
		this.append = this.append.bind(this);
		this.prepend = this.prepend.bind(this);
	}

	append(x: number, y: number) {
		this.points.push(Math.round(x), Math.round(y));
	}

	prepend(x: number, y: number) {
		this.points.splice(0, 0, Math.round(x), Math.round(y));
	}

	lineString() {
		return this.toArray();
	}

	isEmpty() {
		return this.points.length < 2;
	}

	appendFragment(other: Fragment) {
		this.points.push(...other.points);
		this.end = other.end;
	}

	toArray() {
		return this.points;
	}
}

export const index = (width: number, x: number, y: number, point: [number, number]) => {
	x = x * 2 + point[0];
	y = y * 2 + point[1];
	return x + y * (width + 1) * 2;
};

export function interpolate(
	x: number,
	y: number,
	point: [number, number],
	threshold: number,
	multiplier: number,
	bld: number,
	tld: number,
	brd: number,
	trd: number,
	accept: (x: number, y: number) => void
) {
	if (point[0] === 0) {
		accept(multiplier * (x - 1), multiplier * (y - ratio(bld, threshold, tld)));
	} else if (point[0] === 2) {
		// right
		accept(multiplier * x, multiplier * (y - ratio(brd, threshold, trd)));
	} else if (point[1] === 0) {
		// top
		accept(multiplier * (x - ratio(trd, threshold, tld)), multiplier * (y - 1));
	} else {
		// bottom
		accept(multiplier * (x - ratio(brd, threshold, bld)), multiplier * y);
	}
}

export const ratio = (a: number, b: number, c: number) => {
	return (b - a) / (c - a);
};

/** First index with arr[idx] >= value (arr ascending), or arr.length. */
const lowerBound = (arr: number[], value: number): number => {
	let lo = 0,
		hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (arr[mid] < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
};

/** Last index with arr[idx] <= value (arr ascending), or -1. */
const upperBoundInclusive = (arr: number[], value: number): number => {
	let lo = 0,
		hi = arr.length - 1,
		res = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		if (arr[mid] <= value) {
			res = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return res;
};

const isAscending = (arr: number[]): boolean => {
	for (let i = 1; i < arr.length; i++) {
		if (arr[i] < arr[i - 1]) return false;
	}
	return true;
};

export const generateContours = (
	pbf: PbfWriter,
	sampleValue: ValueSampler,
	x: number,
	y: number,
	z: number,
	tileSize: number,
	intervals: number[],
	clippingOptions: ResolvedClippingOptions | undefined,
	// Added to every sample so contour crossings fall off the quantization grid,
	// matching the raster (see halfQuantum / worker). Keeps contours aligned with
	// the colour band edges.
	valueOffset: number = 0,
	extent: number = VECTOR_TILE_EXTENT
) => {
	const features = [];
	let cursor: [number, number] = [0, 0];

	const buffer = 1;

	const width = tileSize;
	const height = tileSize;

	const multiplier = extent / width;
	let i: number, j: number;
	const segments: { [ele: number]: number[][] } = {};
	const fragmentByStartByLevel: Map<number, Map<number, Fragment>> = new Map();
	const fragmentByEndByLevel: Map<number, Map<number, Fragment>> = new Map();

	const isInsideClip = createClippingTester(clippingOptions);

	// User-provided interval lists are only cullable when ascending; color-scale
	// breakpoints always are.
	const intervalsSorted = intervals.length > 1 && isAscending(intervals);

	const processThreshold = (
		threshold: number,
		j: number,
		i: number,
		bld: number,
		tld: number,
		brd: number,
		trd: number
	): void => {
		const tl = tld >= threshold;
		const tr = trd >= threshold;
		const bl = bld >= threshold;
		const br = brd >= threshold;
		for (const segment of CASES[(tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0)]) {
			let fragmentByStart = fragmentByStartByLevel.get(threshold);
			if (!fragmentByStart) fragmentByStartByLevel.set(threshold, (fragmentByStart = new Map()));
			let fragmentByEnd = fragmentByEndByLevel.get(threshold);
			if (!fragmentByEnd) fragmentByEndByLevel.set(threshold, (fragmentByEnd = new Map()));
			const start = segment[0];
			const end = segment[1];
			const startIndex = index(width + buffer, j, i, start);
			const endIndex = index(width + buffer, j, i, end);
			let f, g;

			if ((f = fragmentByEnd.get(startIndex))) {
				fragmentByEnd.delete(startIndex);
				if ((g = fragmentByStart.get(endIndex))) {
					fragmentByStart.delete(endIndex);
					if (f === g) {
						// closing a ring
						interpolate(j, i, end, threshold, multiplier, bld, tld, brd, trd, f.append);
						if (!f.isEmpty()) {
							let list = segments[threshold];
							if (!list) {
								segments[threshold] = list = [];
							}
							list.push(f.lineString());
						}
					} else {
						// connecting 2 segments
						f.appendFragment(g);
						fragmentByEnd.set((f.end = g.end), f);
					}
				} else {
					// adding to the end of f
					interpolate(j, i, end, threshold, multiplier, bld, tld, brd, trd, f.append);
					fragmentByEnd.set((f.end = endIndex), f);
				}
			} else if ((f = fragmentByStart.get(endIndex))) {
				fragmentByStart.delete(endIndex);
				// extending the start of f
				interpolate(j, i, start, threshold, multiplier, bld, tld, brd, trd, f.prepend);
				fragmentByStart.set((f.start = startIndex), f);
			} else {
				// starting a new fragment
				const newFrag = new Fragment(startIndex, endIndex);
				interpolate(j, i, start, threshold, multiplier, bld, tld, brd, trd, newFrag.append);
				interpolate(j, i, end, threshold, multiplier, bld, tld, brd, trd, newFrag.append);
				fragmentByStart.set(startIndex, newFrag);
				fragmentByEnd.set(endIndex, newFrag);
			}
		}
	};

	// Cells run j = -buffer..width+buffer-1, so samples are needed at the lat/lon
	// lines jStart-1..jEnd-1 and iStart-1..iEnd-1. Adjacent cell rows share a lat
	// line, so each line is sampled once into a row buffer and reused by the row
	// below (halves the sampling work — the dominant cost of contour generation).
	const jStart = 0 - buffer;
	const jEnd = width + buffer;
	const iStart = 1 - buffer;
	const iEnd = height + buffer;

	const numCols = jEnd - jStart + 1;
	const lons = new Float64Array(numCols);
	for (let c = 0; c < numCols; c++) {
		lons[c] = tile2lon(x + (jStart - 1 + c) / width, z);
	}

	const sampleRow = (lat: number, out: Float64Array): void => {
		for (let c = 0; c < numCols; c++) {
			out[c] = sampleValue(lat, lons[c]) + valueOffset;
		}
	};

	// North = lat line above the cell row (index i-1), south = line below (index i).
	let rowNorth = new Float64Array(numCols);
	let rowSouth = new Float64Array(numCols);
	sampleRow(tile2lat(y + (iStart - 1) / height, z), rowNorth);

	for (i = iStart; i < iEnd; i++) {
		const latSouth = tile2lat(y + i / height, z);
		const latNorth = tile2lat(y + (i - 1) / height, z);
		sampleRow(latSouth, rowSouth);

		for (j = jStart; j < jEnd; j++) {
			const c = j - (jStart - 1); // right column of this cell; c-1 = left
			const tld = rowNorth[c - 1];
			const trd = rowNorth[c];
			const bld = rowSouth[c - 1];
			const brd = rowSouth[c];

			if (isNaN(tld) || isNaN(trd) || isNaN(brd) || isNaN(bld)) {
				continue;
			}

			if (isInsideClip && !isInsideClip(lons[c], latNorth)) {
				continue;
			}

			const cellMin = Math.min(Math.min(tld, trd), Math.min(bld, brd));
			const cellMax = Math.max(Math.max(tld, trd), Math.max(bld, brd));

			if (intervals.length === 1) {
				const interval = intervals[0];
				const start = Math.ceil(cellMin / interval) * interval;
				const steps = Math.floor(cellMax / interval) - Math.ceil(cellMin / interval);
				for (let k = 0; k <= steps; k++) {
					processThreshold(start + interval * k, j, i, bld, tld, brd, trd);
				}
			} else if (intervalsSorted) {
				// Only thresholds within [cellMin, cellMax] can produce segments in
				// this cell; anything outside yields the empty marching-squares case.
				const from = lowerBound(intervals, cellMin);
				const to = upperBoundInclusive(intervals, cellMax);
				for (let k = from; k <= to; k++) {
					processThreshold(intervals[k], j, i, bld, tld, brd, trd);
				}
			} else {
				for (const threshold of intervals) {
					processThreshold(threshold, j, i, bld, tld, brd, trd);
				}
			}
		}

		// The south line of this row is the north line of the next.
		const swap = rowNorth;
		rowNorth = rowSouth;
		rowSouth = swap;
	}

	for (const [level, fragmentByStart] of fragmentByStartByLevel.entries()) {
		let list: number[][] | null = null;
		for (const value of fragmentByStart.values()) {
			if (!value.isEmpty()) {
				if (list == null) {
					list = segments[level] || (segments[level] = []);
				}
				list.push(value.lineString());
			}
		}
	}

	const levels = segments;

	for (const [level, segments] of Object.entries(levels)) {
		for (const line of segments) {
			const geom: number[] = [];
			// move to first point in segments
			let xt1, yt1;
			geom.push(command(1, 1)); // MoveTo
			const [xt0, yt0] = [line[0], line[1]];
			geom.push(zigzag(xt0));
			geom.push(zigzag(yt0));
			cursor = [xt0, yt0];

			for (let i = 2; i < line.length; i = i + 2) {
				xt1 = line[i];
				yt1 = line[i + 1];

				geom.push(command(2, 1)); // LineTo
				geom.push(zigzag(xt1 - cursor[0]));
				geom.push(zigzag(yt1 - cursor[1]));
				cursor = [xt1, yt1];
			}
			features.push({
				id: 1000000 + Number(level),
				type: 2, // 2 = LineString
				properties: {
					value: level
				},
				geom
			});
		}
	}

	// write Layer
	pbf.writeMessage(3, writeLayer, {
		name: 'contours',
		extent,
		features
	});
};
