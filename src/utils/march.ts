
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

export const CASES: [number, number][][][] = [
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
	return x + y * (width+1) * 2;
};

export function interpolate(
	x: number, y: number,
	point: [number, number],
	threshold: number,
	multiplier: number,
	bld: number, tld: number, brd: number, trd: number,
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
