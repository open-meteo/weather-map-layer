import { GridInterface } from '../grids/index';
import Pbf from 'pbf';

import { tile2lat, tile2lon } from './math';
import { command, writeLayer, zigzag } from './pbf';

// prettier-ignore
export const CASES: [number, number][][][] = [
	[],					       // 0
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

export const generateContours = (
	pbf: Pbf,
	values: Float32Array,
	grid: GridInterface,
	x: number,
	y: number,
	z: number,
	interval: number = 2,
	extent: number = 4096,
	threshold = undefined
) => {
	const features = [];
	let cursor: [number, number] = [0, 0];

	const buffer = 1;

	const width = 128;
	const height = width;

	const multiplier = extent / width;
	let tld: number, bld: number;
	let i: number, j: number;
	const segments: { [ele: number]: number[][] } = {};
	const fragmentByStartByLevel: Map<number, Map<number, Fragment>> = new Map();
	const fragmentByEndByLevel: Map<number, Map<number, Fragment>> = new Map();

	for (i = 1 - buffer; i < height + buffer; i++) {
		const latTop = tile2lat(y + i / height, z);
		const latBottom = tile2lat(y + (i - 1) / height, z);
		const lon = tile2lon(x + 0 / height, z);

		let trd = grid.getLinearInterpolatedValue(values, latBottom, lon);
		let brd = grid.getLinearInterpolatedValue(values, latTop, lon);

		let minR = Math.min(trd, brd);
		let maxR = Math.max(trd, brd);

		for (j = 0 - buffer; j < width + buffer; j++) {
			const lon = tile2lon(x + j / width, z);

			tld = trd;
			bld = brd;

			trd = grid.getLinearInterpolatedValue(values, latBottom, lon);
			brd = grid.getLinearInterpolatedValue(values, latTop, lon);

			// trd = tile.get(j, i - 1);
			// brd = tile.get(j, i);
			const minL = minR;
			const maxL = maxR;
			minR = Math.min(trd, brd);
			maxR = Math.max(trd, brd);
			if (isNaN(tld) || isNaN(trd) || isNaN(brd) || isNaN(bld)) {
				continue;
			}
			const min = Math.min(minL, minR);
			const max = Math.max(maxL, maxR);
			const start = Math.ceil(min / interval) * interval;
			const end = Math.floor(max / interval) * interval;

			for (let threshold = start; threshold <= end; threshold += interval) {
				const tl = tld > threshold;
				const tr = trd > threshold;
				const bl = bld > threshold;
				const br = brd > threshold;
				for (const segment of CASES[(tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0)]) {
					let fragmentByStart = fragmentByStartByLevel.get(threshold);
					if (!fragmentByStart)
						fragmentByStartByLevel.set(threshold, (fragmentByStart = new Map()));
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
			}
		}
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
		features: features
	});
};
