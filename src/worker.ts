import Pbf from 'pbf';

import { getColor, getOpacity } from './utils/color-scales';
import { MS_TO_KMH } from './utils/constants';
import { generateContours } from './utils/contours';
import { generateGridPoints } from './utils/grid-points';
import { degreesToRadians, rotatePoint, tile2lat, tile2lon } from './utils/math';
import { drawOnTiles, hideZero } from './utils/variables';

import { GridFactory, GridInterface } from './grids/index';
import { TileRequest } from './worker-pool';

import type { Variable } from './types';

const OPACITY = 75;

let arrowCanvas: OffscreenCanvasRenderingContext2D | null = null;
const getArrowCanvas = (size: number) => {
	if (arrowCanvas != null) {
		return arrowCanvas;
	}

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
};

const drawArrow = (
	rgba: Uint8ClampedArray,
	iBase: number,
	jBase: number,
	x: number,
	y: number,
	z: number,
	values: Float32Array,
	tileSize: number,
	boxSize: number,
	variable: Variable,
	grid: GridInterface,
	directions: Float32Array
): void => {
	const arrow = getArrowCanvas(boxSize);

	const iCenter = iBase + Math.floor(boxSize / 2);
	const jCenter = jBase + Math.floor(boxSize / 2);

	const lat = tile2lat(y + iCenter / tileSize, z);
	const lon = tile2lon(x + jCenter / tileSize, z);

	const px = grid.getLinearInterpolatedValue(values, lat, lon);
	const direction = degreesToRadians(grid.getLinearInterpolatedValue(directions, lat, lon));

	arrow.rotate(direction);
	const arrowPixelData = arrow.getImageData(0, 0, boxSize, boxSize).data;

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
				const indTile = jBase + newJ + (iBase + newI) * tileSize;

				let opacityValue;

				if (variable.value.startsWith('wind')) {
					opacityValue = Math.min(((px - 0.4) / 1) * 0.5, 1);
				} else {
					opacityValue = 0.8;
				}

				if (arrowPixelData[4 * ind + 3] && opacityValue > 0.1) {
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

self.onmessage = async (message: MessageEvent<TileRequest>): Promise<void> => {
	if (message.data.type == 'getImage') {
		const key = message.data.key;

		const x = message.data.x;
		const y = message.data.y;
		const z = message.data.z;

		const dark = message.data.dark;
		const values = message.data.data.values;
		const ranges = message.data.ranges;
		const tileSize = message.data.tileSize;
		const domain = message.data.domain;
		const variable = message.data.variable;
		const colorScale = message.data.colorScale;

		const pixels = tileSize * tileSize;
		const rgba = new Uint8ClampedArray(pixels * 4);

		if (!values) {
			throw new Error('No values provided');
		}

		// const interpolationMethod = getInterpolationMethod(colorScale);
		const grid = GridFactory.create(domain.grid, ranges);

		const isWind = variable.value.includes('wind');
		const isWeatherCode = variable.value === 'weather_code';
		const isDirection =
			(variable.value.startsWith('wave') && !variable.value.includes('_period')) ||
			(variable.value.startsWith('wind') &&
				!variable.value.includes('_gusts') &&
				!variable.value.includes('_wave')) ||
			(drawOnTiles.includes(variable.value) &&
				(variable.value.startsWith('wave') || variable.value.startsWith('wind')));
		const isHideZero = hideZero.includes(variable.value);

		for (let i = 0; i < tileSize; i++) {
			const lat = tile2lat(y + i / tileSize, z);
			for (let j = 0; j < tileSize; j++) {
				const ind = j + i * tileSize;
				const lon = tile2lon(x + j / tileSize, z);
				let px = grid.getLinearInterpolatedValue(values, lat, lon);

				if (isHideZero) {
					if (px < 0.25) {
						px = NaN;
					}
				}

				if (isWind) {
					px = px * MS_TO_KMH;
				}

				if (isNaN(px) || px === Infinity || isWeatherCode) {
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

		if (isDirection) {
			const directions = message.data.data.directions;
			if (!directions) {
				throw new Error('Directions are required for direction layer');
			}

			const boxSize = Math.floor(tileSize / 8);
			for (let i = 0; i < tileSize; i += boxSize) {
				for (let j = 0; j < tileSize; j += boxSize) {
					drawArrow(rgba, i, j, x, y, z, values, tileSize, boxSize, variable, grid, directions);
				}
			}
		}

		const imageBitmap = await createImageBitmap(new ImageData(rgba, tileSize, tileSize), {
			premultiplyAlpha: 'premultiply'
		});
		postMessage({ type: 'returnImage', tile: imageBitmap, key: key }, { transfer: [imageBitmap] });
	} else if (message.data.type == 'getArrayBuffer') {
		const key = message.data.key;

		const x = message.data.x;
		const y = message.data.y;
		const z = message.data.z;

		const values = message.data.data.values;
		const ranges = message.data.ranges;
		const domain = message.data.domain;
		const interval = message.data.interval;
		const directions = message.data.data.directions;

		if (!values) {
			throw new Error('No values provided');
		}

		const pbf = new Pbf();

		if (key.includes('grid=true')) {
			if (domain.grid.type !== 'regular') {
				throw new Error('Only regular grid types supported');
			}
			generateGridPoints(pbf, values, directions, domain.grid, x, y, z);
		} else {
			const grid = GridFactory.create(domain.grid, ranges);
			generateContours(pbf, values, grid, x, y, z, interval ? interval : 2);
		}

		const arrayBuffer = pbf.finish();
		postMessage(
			{ type: 'returnArrayBuffer', tile: arrayBuffer.buffer, key: key },
			{ transfer: [arrayBuffer.buffer] }
		);
	}
};
