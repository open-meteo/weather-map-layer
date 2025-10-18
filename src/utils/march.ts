import type { Domain } from '../types';

import { lon2tile, lat2tile, tile2lat, tile2lon } from './math';

import type { TypedArray } from '@openmeteo/file-reader';

// prettier-ignore
export const edgeTable = [
	 [],			    // 0
	 [[3, 0]],		 	// 1
	 [[0, 1]],          // 2
	 [[3, 1]],          // 3
	 [[1, 2]],          // 4
	 [[3, 0], [1, 2]],  // 5
	 [[0, 1], [1, 2]],  // 6
	 [[3, 2]],          // 7
	 [[2, 3]],          // 8
	 [[0, 2], [2, 3]],  // 9
	 [[1, 3], [2, 3]],  // 10
	 [[0, 3]],          // 11
	 [[1, 3]],          // 12
	 [[0, 1], [1, 3]],  // 13
	 [[0, 3], [1, 2]],  // 14
	 []                 // 15
];

const CASES: [number, number][][][] = [
	[],
	[
		[
			[1, 2],
			[0, 1]
		]
	],
	[
		[
			[2, 1],
			[1, 2]
		]
	],
	[
		[
			[2, 1],
			[0, 1]
		]
	],
	[
		[
			[1, 0],
			[2, 1]
		]
	],
	[
		[
			[1, 2],
			[0, 1]
		],
		[
			[1, 0],
			[2, 1]
		]
	],
	[
		[
			[1, 0],
			[1, 2]
		]
	],
	[
		[
			[1, 0],
			[0, 1]
		]
	],
	[
		[
			[0, 1],
			[1, 0]
		]
	],
	[
		[
			[1, 2],
			[1, 0]
		]
	],
	[
		[
			[0, 1],
			[1, 0]
		],
		[
			[2, 1],
			[1, 2]
		]
	],
	[
		[
			[2, 1],
			[1, 0]
		]
	],
	[
		[
			[0, 1],
			[2, 1]
		]
	],
	[
		[
			[1, 2],
			[2, 1]
		]
	],
	[
		[
			[0, 1],
			[1, 2]
		]
	],
	[]
];

class Fragment {
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

const index = (width: number, x: number, y: number, point: [number, number]) => {
	x = x * 2 + point[0];
	y = y * 2 + point[1];
	return x + y * (width + 1) * 2;
};

const ratio = (a: number, b: number, c: number) => {
	return (b - a) / (c - a);
};

export const marchingSquares = (
	values: TypedArray,
	z: number,
	y: number,
	x: number,
	domain: Domain
): number[][] => {
	// const segments = [];

	const nx = domain.grid.nx;
	const ny = domain.grid.ny;

	const dx = domain.grid.dx;
	const dy = domain.grid.dy;

	const latMin = domain.grid.latMin;
	const lonMin = domain.grid.lonMin;

	const tileSize = 4096;
	const margin = 256;

	const interval = 5;
	const buffer = 1;
	const tile = {
		width: nx,
		height: nx,
		get: (x: number, y: number) => {
			return values[y * nx + x];
		}
	};

	const multiplier = 1;
	let tld: number, trd: number, bld: number, brd: number;
	let r: number, c: number;
	const segments: { [ele: string]: number[][] } = {};
	const fragmentByStartByLevel: Map<number, Map<number, Fragment>> = new Map();
	const fragmentByEndByLevel: Map<number, Map<number, Fragment>> = new Map();

	function interpolate(
		point: [number, number],
		threshold: number,
		accept: (x: number, y: number) => void
	) {
		if (point[0] === 0) {
			// left
			accept(multiplier * (c - 1), multiplier * (r - ratio(bld, threshold, tld)));
		} else if (point[0] === 2) {
			// right
			accept(multiplier * c, multiplier * (r - ratio(brd, threshold, trd)));
		} else if (point[1] === 0) {
			// top
			accept(multiplier * (c - ratio(trd, threshold, tld)), multiplier * (r - 1));
		} else {
			// bottom
			accept(multiplier * (c - ratio(brd, threshold, bld)), multiplier * r);
		}
	}

	for (r = 1 - buffer; r < tile.height + buffer; r++) {
		trd = tile.get(0, r - 1);
		brd = tile.get(0, r);
		let minR = Math.min(trd, brd);
		let maxR = Math.max(trd, brd);

		for (c = 1 - buffer; c < tile.width + buffer; c++) {
			tld = trd;
			bld = brd;
			trd = tile.get(c, r - 1);
			brd = tile.get(c, r);
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
					const startIndex = index(tile.width, c, r, start);
					const endIndex = index(tile.width, c, r, end);
					let f, g;

					if ((f = fragmentByEnd.get(startIndex))) {
						fragmentByEnd.delete(startIndex);
						if ((g = fragmentByStart.get(endIndex))) {
							fragmentByStart.delete(endIndex);
							if (f === g) {
								// closing a ring
								interpolate(end, threshold, f.append);
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
							interpolate(end, threshold, f.append);
							fragmentByEnd.set((f.end = endIndex), f);
						}
					} else if ((f = fragmentByStart.get(endIndex))) {
						fragmentByStart.delete(endIndex);
						// extending the start of f
						interpolate(start, threshold, f.prepend);
						fragmentByStart.set((f.start = startIndex), f);
					} else {
						// starting a new fragment
						const newFrag = new Fragment(startIndex, endIndex);
						interpolate(start, threshold, newFrag.append);
						interpolate(end, threshold, newFrag.append);
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

	return segments;

	// const minLonTile = tile2lon(x, z);
	// const minLatTile = tile2lat(y, z);
	// const maxLonTile = tile2lon(x + 1, z);
	// const maxLatTile = tile2lat(y + 1, z);

	// for (let j = 0; j < ny; j++) {
	// 	const lat = latMin + dy * j;
	// 	// if (lat > minLatTile && lat < maxLatTile) {
	// 	const worldPy = Math.floor(lat2tile(lat, z) * tileSize);
	// 	const py = worldPy - y * tileSize;
	// 	if (py > -margin && py <= tileSize + margin) {
	// 		for (let i = 0; i < nx; i++) {
	// 			const lon = lonMin + dx * i;
	// 			// if (lon > minLonTile && lon < maxLonTile) {
	// 			const worldPx = Math.floor(lon2tile(lon, z) * tileSize);
	// 			const px = worldPx - x * tileSize;
	// 			if (px > -margin && px <= tileSize + margin) {
	// 				const index = j * nx + i;

	// 				/* v3 ------- v2
	// 				 * |      	  |
	// 				 * |      	  |
	// 				 * v0 ------- v1
	// 				 *
	// 				 * v0 = (i, j)
	// 				 * v1 = (i + 1, j)
	// 				 * v2 = (i + 1, j + 1)
	// 				 * v3 = (i, j + 1) */

	// 				const v0 = values[index]; // (i, j)  west‑south, or bottom-left
	// 				const v1 = values[index + 1]; // (i + 1, j)  east‑south, bottom-right
	// 				const v2 = values[index + nx + 1]; // (i + 1, j + 1) east‑north, or top-right
	// 				const v3 = values[index + nx]; //  (i, j + 1) west‑north, or top-left

	// 				const edgeCode =
	// 					(v0 > threshold ? 1 : 0) |
	// 					(v1 > threshold ? 2 : 0) |
	// 					(v2 > threshold ? 4 : 0) |
	// 					(v3 > threshold ? 8 : 0);

	// 				if (edgeCode === 0 || edgeCode === 15) continue; // no contour inside this cell

	// 				// ----- fetch the edges that need intersections -----
	// 				// const edges = edgeTable[edgeCode];

	// 				/* 	 ---------- x1, y1
	// 				 * 	|      	  	|
	// 				 * 	|      	  	|
	// 				 * x0, y0 -------
	// 				 *
	// 				 * x0 = px
	// 				 * y0 = py
	// 				 * x1 = ... + dx;
	// 				 * y1 = ... + dy */

	// 				// ----- corners of 4 gridcells in tile coordinates -----
	// 				// const x0 = px;
	// 				// const y0 = py;
	// 				// const x1 = Math.floor(lon2tile(lon + dx, z) * tileSize) - x * tileSize;
	// 				// const y1 = Math.floor(lat2tile(lat + dy, z) * tileSize) - y * tileSize;

	// 				// ----- corners of 4 gridcells in wgs84 coordinates -----
	// 				// const x0 = lon;
	// 				// const y0 = lat;
	// 				// const x1 = lon + dx;
	// 				// const y1 = lat + dy;

	// 				/* 	 ---- p2 ----
	// 				 * 	|			|
	// 				 *  p3	        p1
	// 				 * 	|      	  	|
	// 				 * 	 ---- p0 ----   */

	// 				const p0 = [Math.floor(lon2tile(lon + 0.5 * dx, z) * tileSize) - x * tileSize, py];
	// 				const p1 = [
	// 					Math.floor(lon2tile(lon + dx, z) * tileSize) - x * tileSize,
	// 					Math.floor(lat2tile(lat + 0.5 * dy, z) * tileSize) - y * tileSize
	// 				];
	// 				const p2 = [
	// 					Math.floor(lon2tile(lon + 0.5 * dx, z) * tileSize) - x * tileSize,
	// 					Math.floor(lat2tile(lat + 1 * dy, z) * tileSize) - y * tileSize
	// 				];
	// 				const p3 = [px, Math.floor(lat2tile(lat + 0.5 * dy, z) * tileSize) - y * tileSize];

	// 				switch (edgeCode) {
	// 					case 1:
	// 					case 14:
	// 						segments.push([...p3, ...p0]);
	// 						break;

	// 					case 2:
	// 					case 13:
	// 						segments.push([...p0, ...p1]);
	// 						break;

	// 					case 3:
	// 					case 12:
	// 						segments.push([...p3, ...p1]);
	// 						break;

	// 					case 11:
	// 					case 4:
	// 						segments.push([...p2, ...p1]);
	// 						break;

	// 					case 5:
	// 						segments.push([...p0, ...p1]);
	// 						segments.push([...p2, ...p3]);
	// 						break;
	// 					case 6:
	// 					case 9:
	// 						segments.push([...p2, ...p0]);
	// 						break;

	// 					case 7:
	// 					case 8:
	// 						segments.push([...p2, ...p3]);
	// 						break;

	// 					case 10:
	// 						segments.push([...p3, ...p0]);
	// 						segments.push([...p1, ...p2]);
	// 						break;
	// 					default:
	// 						break;
	// 				}
	// 			}
	// 			// 	}
	// 			// }
	// 		}
	// 	}
	// }

	// return segments;
};
