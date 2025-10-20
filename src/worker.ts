import { hideZero, drawOnTiles } from './utils/variables';

import { DynamicProjection, ProjectionGrid, type Projection } from './utils/projections';

import {
	tile2lat,
	tile2lon,
	rotatePoint,
	degreesToRadians,
	getIndexFromLatLong
} from './utils/math';

import { getColor, getInterpolator, getOpacity } from './utils/color-scales';

import type { Domain, Variable, Interpolator, DimensionRange, IndexAndFractions } from './types';

const TILE_SIZE = 256 * 2;
const OPACITY = 75;

let arrowCanvas: OffscreenCanvasRenderingContext2D | null = null;
function getArrowCanvas() {
	if (arrowCanvas != null) {
		return arrowCanvas;
	}

	const size = 64;
	const canvas = new OffscreenCanvas(size, size);
	const ctx = canvas.getContext('2d');
	if (ctx == null) {
		throw new Error('Failed to create arrow canvas');
	}

	ctx.clearRect(0, 0, size, size);
	ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
	ctx.beginPath();
	ctx.moveTo(size / 2, size * 0.1);
	ctx.lineTo(size * 0.63, size * 0.32);
	ctx.lineTo(size / 2, size * 0.1);
	ctx.lineTo(size * 0.37, size * 0.32);
	ctx.lineTo(size / 2, size * 0.1);
	ctx.lineTo(size / 2, size * 0.95);
	ctx.stroke();

	arrowCanvas = ctx;
	return ctx;
}

const drawArrow = (
	rgba: Uint8ClampedArray,
	iBase: number,
	jBase: number,
	x: number,
	y: number,
	z: number,
	values: Float32Array,
	ranges: DimensionRange[],
	boxSize = TILE_SIZE / 8,
	domain: Domain,
	variable: Variable,
	directions: Float32Array,
	interpolator: Interpolator,
	projectionGrid: ProjectionGrid | null,
	latLonMinMax: [minLat: number, minLon: number, maxLat: number, maxLon: number]
): void => {
	const arrow = getArrowCanvas();

	const iCenter = iBase + Math.floor(boxSize / 2);
	const jCenter = jBase + Math.floor(boxSize / 2);

	const lat = tile2lat(y + iCenter / TILE_SIZE, z);
	const lon = tile2lon(x + jCenter / TILE_SIZE, z);

	const { index, xFraction, yFraction } = getIndexAndFractions(
		lat,
		lon,
		domain,
		projectionGrid,
		ranges,
		latLonMinMax
	);

	const px = interpolator(values, index, xFraction, yFraction, ranges);
	const direction = degreesToRadians(
		interpolator(directions, index, xFraction, yFraction, ranges) + 180
	);

	arrow.rotate(direction);
	const arrowPixelData = arrow.getImageData(0, 0, 64, 64).data;

	if (direction) {
		for (let i = 0; i < boxSize; i++) {
			for (let j = 0; j < boxSize; j++) {
				const ind = j + i * boxSize;
				const rotatedPoint = rotatePoint(
					Math.floor(boxSize / 2),
					Math.floor(boxSize / 2),
					-direction,
					i,
					j
				);
				const newI = Math.floor(rotatedPoint[0]);
				const newJ = Math.floor(rotatedPoint[1]);
				const indTile = jBase + newJ + (iBase + newI) * TILE_SIZE;

				let opacityValue;

				if (variable.value.startsWith('wind')) {
					opacityValue = Math.min(((px - 2) / 2) * 0.5, 1);
				} else {
					opacityValue = 0.8;
				}

				if (arrowPixelData[4 * ind + 3]) {
					rgba[4 * indTile] = 0;
					rgba[4 * indTile + 1] = 0;
					rgba[4 * indTile + 2] = 0;
					rgba[4 * indTile + 3] =
						Number(arrowPixelData[4 * ind + 3]) * opacityValue * (OPACITY / 25);
				}
			}
		}
	}
};

const getIndexAndFractions = (
	lat: number,
	lon: number,
	domain: Domain,
	projectionGrid: ProjectionGrid | null,
	ranges = [
		{ start: 0, end: domain.grid.ny },
		{ start: 0, end: domain.grid.nx }
	],
	latLonMinMax: [minLat: number, minLon: number, maxLat: number, maxLon: number]
) => {
	let indexObject: IndexAndFractions;
	if (domain.grid.projection && projectionGrid) {
		indexObject = projectionGrid.findPointInterpolated(lat, lon, ranges);
	} else {
		indexObject = getIndexFromLatLong(
			lat,
			lon,
			domain.grid.dx,
			domain.grid.dy,
			ranges[1]['end'] - ranges[1]['start'],
			latLonMinMax
		);
	}

	return (
		indexObject ?? {
			index: NaN,
			xFraction: 0,
			yFraction: 0
		}
	);
};

self.onmessage = async (message) => {
	if (message.data.type == 'GT') {
		const key = message.data.key;
		const x = message.data.x;
		const y = message.data.y;
		const z = message.data.z;
		const values = message.data.data.values;
		const ranges = message.data.ranges;

		const domain = message.data.domain;
		const variable = message.data.variable;
		const colorScale = message.data.colorScale;

		const pixels = TILE_SIZE * TILE_SIZE;
		const rgba = new Uint8ClampedArray(pixels * 4);
		const dark = message.data.dark;

		let projectionGrid = null;
		if (domain.grid.projection) {
			const projectionName = domain.grid.projection.name;
			const projection = new DynamicProjection(
				projectionName,
				domain.grid.projection
			) as Projection;
			projectionGrid = new ProjectionGrid(projection, domain.grid, ranges);
		}

		const interpolator = getInterpolator(colorScale);

		const lonMin = domain.grid.lonMin + domain.grid.dx * ranges[1]['start'];
		const latMin = domain.grid.latMin + domain.grid.dy * ranges[0]['start'];
		const lonMax = domain.grid.lonMin + domain.grid.dx * ranges[1]['end'];
		const latMax = domain.grid.latMin + domain.grid.dy * ranges[0]['end'];

		for (let i = 0; i < TILE_SIZE; i++) {
			const lat = tile2lat(y + i / TILE_SIZE, z);
			for (let j = 0; j < TILE_SIZE; j++) {
				const ind = j + i * TILE_SIZE;
				const lon = tile2lon(x + j / TILE_SIZE, z);

				const { index, xFraction, yFraction } = getIndexAndFractions(
					lat,
					lon,
					domain,
					projectionGrid,
					ranges,
					[latMin, lonMin, latMax, lonMax]
				);

				let px = interpolator(values as Float32Array, index, xFraction, yFraction, ranges);

				if (hideZero.includes(variable.value)) {
					if (px < 0.25) {
						px = NaN;
					}
				}

				if (isNaN(px) || px === Infinity || variable.value === 'weather_code') {
					rgba[4 * ind] = 0;
					rgba[4 * ind + 1] = 0;
					rgba[4 * ind + 2] = 0;
					rgba[4 * ind + 3] = 0;
				} else {
					const color = getColor(colorScale, px);

					if (color) {
						rgba[4 * ind] = color[0];
						rgba[4 * ind + 1] = color[1];
						rgba[4 * ind + 2] = color[2];
						rgba[4 * ind + 3] = getOpacity(variable.value, px, dark, colorScale);
					}
				}
			}
		}

		if (
			(variable.value.startsWith('wave') && !variable.value.includes('_period')) ||
			(variable.value.startsWith('wind') &&
				!variable.value.includes('_gusts') &&
				!variable.value.includes('_wave')) ||
			drawOnTiles.includes(variable.value)
		) {
			if (variable.value.startsWith('wave') || variable.value.startsWith('wind')) {
				const directions = message.data.data.directions;

				const boxSize = Math.floor(TILE_SIZE / 8);
				for (let i = 0; i < TILE_SIZE; i += boxSize) {
					for (let j = 0; j < TILE_SIZE; j += boxSize) {
						drawArrow(
							rgba,
							i,
							j,
							x,
							y,
							z,
							values,
							ranges,
							boxSize,
							domain,
							variable,
							directions,
							interpolator,
							projectionGrid,
							[latMin, lonMin, latMax, lonMax]
						);
					}
				}
			}
		}

		const tile = await createImageBitmap(new ImageData(rgba, TILE_SIZE, TILE_SIZE));

		postMessage({ type: 'RT', tile: tile, key: key });
	}
};
