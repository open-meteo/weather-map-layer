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

import type {
	Domain,
	Variable,
	ColorScale,
	Interpolator,
	DimensionRange,
	IndexAndFractions
} from './types';

import type { IconListPixels } from './utils/arrow';

const TILE_SIZE = 256 * 2;
const OPACITY = 75;

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
	northArrowPixelData: Uint8ClampedArray,
	latLonMinMax: [minLat: number, minLon: number, maxLat: number, maxLon: number]
): void => {
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

	const direction = degreesToRadians(interpolator(directions, index, xFraction, yFraction, ranges));

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
					opacityValue = Math.min(((px - 2) / 200) * 50, 100);
				} else {
					opacityValue = 0.8;
				}

				if (northArrowPixelData[4 * ind + 3]) {
					rgba[4 * indTile] = 0;
					rgba[4 * indTile + 1] = 0;
					rgba[4 * indTile + 2] = 0;
					rgba[4 * indTile + 3] =
						Number(northArrowPixelData[4 * ind + 3]) * opacityValue * (OPACITY / 50);
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

				let px = NaN
				if (domain.grid.gaussianGridLatitudeLines) {
					const latitudeLines = domain.grid.gaussianGridLatitudeLines
					const dy = 180 / (2 * latitudeLines + 0.5);
					const count = 6599680;

					const nearestNeighbor = false
					if (nearestNeighbor) {
						// nearest neighbor
						const y = (Math.round(latitudeLines - 1 - (lat - dy / 2) / dy) + 2 * latitudeLines) % (2 * latitudeLines);
						const nx = y < latitudeLines ? 20 + y * 4 : (2 * latitudeLines - y - 1) * 4 + 20;
						const dx = 360 / nx;
						const x = (Math.floor(lon / dx) + nx) % nx;
						const integral = y < latitudeLines ? 2 * y * y + 18 * y : count - (2 * (2 * latitudeLines - y) * (2 * latitudeLines - y) + 18 * (2 * latitudeLines - y));
						const index = integral + x
						px = values[index]
					} else {
						// linear interpolation
						const yLower = (Math.floor(latitudeLines - 1 - (lat - dy / 2) / dy) + 2 * latitudeLines) % (2 * latitudeLines);
						const yFraction = (latitudeLines - 1 - (lat - dy / 2) / dy) % 1
						const yUpper = yLower + 1;
						const nxLower = yLower < latitudeLines ? 20 + yLower * 4 : (2 * latitudeLines - yLower - 1) * 4 + 20;
						const nxUpper = yUpper < latitudeLines ? 20 + yUpper * 4 : (2 * latitudeLines - yUpper - 1) * 4 + 20;
						const dxLower = 360 / nxLower;
						const dxUpper = 360 / nxUpper;
						const xLower0 = (Math.floor(lon / dxLower) + nxLower) % nxLower;
						const xUpper0 = (Math.floor(lon / dxUpper) + nxUpper) % nxUpper;
						const integralLower = yLower < latitudeLines ? 2 * yLower * yLower + 18 * yLower : count - (2 * (2 * latitudeLines - yLower) * (2 * latitudeLines - yLower) + 18 * (2 * latitudeLines - yLower));
						const integralUpper = yUpper < latitudeLines ? 2 * yUpper * yUpper + 18 * yUpper : count - (2 * (2 * latitudeLines - yUpper) * (2 * latitudeLines - yUpper) + 18 * (2 * latitudeLines - yUpper));
						const indexLower = integralLower + xLower0;
						const indexUpper = integralUpper + xUpper0;
						const xFractionLower = (lon / dxLower) % 1
						const xFractionUpper = (lon / dxUpper) % 1
						const p0 = values[indexLower]
						const p1 = values[indexLower+1]
						const p2 = values[indexUpper]
						const p3 = values[indexUpper+1]
						px = p0 * (1 - xFractionLower) * (1 - yFraction) +
							p1 * xFractionLower * (1 - yFraction) +
							p2 * (1 - xFractionUpper) * yFraction +
							p3 * xFractionUpper * yFraction
					}
				} else {
					const { index, xFraction, yFraction } = getIndexAndFractions(
						lat,
						lon,
						domain,
						projectionGrid,
						ranges,
						[latMin, lonMin, latMax, lonMax]
					);

					px = interpolator(values as Float32Array, index, xFraction, yFraction, ranges);
				}

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
				const northArrowPixelData = message.data.northArrow;
				const directions = message.data.data.directions;

				const boxSize = Math.floor(TILE_SIZE / 16);
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
							northArrowPixelData,
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
