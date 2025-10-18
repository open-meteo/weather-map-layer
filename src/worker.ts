import Pbf from 'pbf';

import { hideZero, drawOnTiles } from './utils/variables';

import { DynamicProjection, ProjectionGrid, type Projection } from './utils/projections';

import {
	tile2lat,
	tile2lon,
	lat2tile,
	lon2tile,
	rotatePoint,
	degreesToRadians,
	getIndexFromLatLong
} from './utils/math';

import { getColor, getInterpolator, getOpacity } from './utils/color-scales';

import type { Domain, Variable, Interpolator, DimensionRange, IndexAndFractions } from './types';

import { marchingSquares } from './utils/march';

import { VectorTile, VectorTileLayer } from '@mapbox/vector-tile';

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
	if (message.data.type == 'getImage') {
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

		postMessage({ type: 'returnImage', tile: tile, key: key });
	} else if (message.data.type == 'getArrayBuffer') {
		const x = message.data.x;
		const y = message.data.y;
		const z = message.data.z;
		const key = message.data.key;
		const values = message.data.data.values;
		const domain = message.data.domain;

		const extent = 4096;
		const margin = 256;
		const layerName = 'contours';

		const pbf = new Pbf();

		if (key.includes('grid=true')) {
			const features = [];
			const directions = message.data.data.directions;

			let mod = 4;
			if (z > 1) {
				mod = 3;
			}
			if (z > 2) {
				mod = 2;
			}
			if (z > 3) {
				mod = 1;
			}

			for (let j = 0; j < domain.grid.ny; j += mod) {
				const lat = domain.grid.latMin + domain.grid.dy * j;
				// if (lat > minLatTile && lat < maxLatTile) {
				const worldPy = Math.floor(lat2tile(lat, z) * extent);
				const py = worldPy - y * extent;
				if (py > -margin && py <= extent + margin) {
					for (let i = 0; i < domain.grid.nx; i += mod) {
						const lon = domain.grid.lonMin + domain.grid.dx * i;
						// if (lon > minLonTile && lon < maxLonTile) {
						const worldPx = Math.floor(lon2tile(lon, z) * extent);
						const px = worldPx - x * extent;
						if (px > -margin && px <= extent + margin) {
							const index = j * domain.grid.nx + i;
							const value = values[index];

							const properties: { value?: number; direction?: number } = {};
							properties.value = values[index].toFixed(2);
							if (directions) {
								properties.direction = directions[index];
							}

							if (!isNaN(value)) {
								features.push({
									id: index,
									type: 1, // 1 = Point
									properties: properties,
									geom: [
										command(1, 1), // MoveTo
										zigzag(px),
										zigzag(py)
									]
								});
							}
						}
					}
				}
			}
			// write Layer
			pbf.writeMessage(3, writeLayer, {
				name: 'grid',
				extent,
				features: features
			});
		} else {
			const features = [];
			let cursor: [number, number] = [0, 0];

			const levels = marchingSquares(values, z, y, x, domain);

			for (let [level, segments] of Object.entries(levels)) {
				for (let line of segments) {
					const geom: number[] = [];
					// move to first point in segments
					let xt0, yt0, xt1, yt1;
					geom.push(command(1, 1)); // MoveTo
					[xt0, yt0] = [line[0], line[1]];
					geom.push(zigzag(xt0 - cursor[0]));
					geom.push(zigzag(yt0 - cursor[1]));
					cursor = [xt0, yt0];

					for (let i = 2; i < line.length / 2; i = i + 2) {
						xt1 = line[i];
						yt1 = line[i + 1];

						geom.push(command(2, 1)); // LineTo
						geom.push(zigzag(xt1 - cursor[0]));
						geom.push(zigzag(yt1 - cursor[1]));
						cursor = [xt1, yt1];
					}

					features.push({
						id: level,
						type: 2, // 2 = LineString
						properties: {
							lw: level % 100 === 0 ? 2 : level % 50 === 0 ? 1.5 : level % 10 === 0 ? 1 : 0.5,
							pressure: level
						},
						geom
					});
				}
			}

			// write Layer
			pbf.writeMessage(3, writeLayer, {
				name: layerName,
				extent,
				features: features
			});
		}

		postMessage({ type: 'returnArrayBuffer', tile: pbf.finish(), key: key });
	}
};

interface Feature {
	id: number;
	type: number;
	properties: {};
	geom: number[];
}

interface Context {
	feature: Feature | undefined;
	keys: string[];
	values: any[];
	keycache: {};
	valuecache: {};
}

// writer for VectorTileLayer
function writeLayer(layer: any, pbf: Pbf) {
	pbf.writeVarintField(15, layer.version || 2);
	// name
	pbf.writeStringField(1, layer.name);
	// extent
	pbf.writeVarintField(5, layer.extent);

	const context: Context = {
		feature: undefined,
		keys: [],
		values: [],
		keycache: {},
		valuecache: {}
	};

	// for (let i = 0; i < layer.length; i++) {
	// 	context.feature = layer.feature(i);
	// 	pbf.writeMessage(2, writeFeature, context);
	// }

	layer.features.forEach((feat: Feature) => {
		context.feature = feat;
		pbf.writeMessage(2, writeFeature, context);
	});

	const keys = context.keys;
	for (let i = 0; i < keys.length; i++) {
		pbf.writeStringField(3, keys[i]);
	}

	const values = context.values;
	for (let i = 0; i < values.length; i++) {
		pbf.writeMessage(4, writeValue, values[i]);
	}
}

function writeFeature(context: Context, pbf: Pbf) {
	const feature = context.feature;

	if (feature.id !== undefined) {
		pbf.writeVarintField(1, feature.id);
	}

	pbf.writeMessage(2, writeProperties, context);
	pbf.writeVarintField(3, feature.type);
	pbf.writePackedVarint(4, feature.geom);
}

function command(cmd: number, length: number) {
	return (length << 3) + (cmd & 0x7);
}

function zigzag(n: number) {
	return (n << 1) ^ (n >> 31);
}

function writeGeometry(feature, pbf: Pbf) {
	const geometry = feature.loadGeometry();
	const type = feature.type;
	let x = 0;
	let y = 0;
	const rings = geometry.length;
	for (let r = 0; r < rings; r++) {
		const ring = geometry[r];
		let count = 1;
		if (type === 1) {
			count = ring.length;
		}
		pbf.writeVarint(command(1, count)); // moveto
		// do not write polygon closing path as lineto
		const lineCount = type === 3 ? ring.length - 1 : ring.length;
		for (let i = 0; i < lineCount; i++) {
			if (i === 1 && type !== 1) {
				pbf.writeVarint(command(2, lineCount - 1)); // lineto
			}
			const dx = ring[i].x - x;
			const dy = ring[i].y - y;
			pbf.writeVarint(zigzag(dx));
			pbf.writeVarint(zigzag(dy));
			x += dx;
			y += dy;
		}
		if (type === 3) {
			pbf.writeVarint(command(7, 1)); // closepath
		}
	}
}

function writeProperties(context, pbf: Pbf) {
	const feature = context.feature;
	const keys = context.keys;
	const values = context.values;
	const keycache = context.keycache;
	const valuecache = context.valuecache;

	for (const key in feature.properties) {
		let value = feature.properties[key];

		let keyIndex = keycache[key];
		if (value === null) continue; // don't encode null value properties

		if (typeof keyIndex === 'undefined') {
			keys.push(key);
			keyIndex = keys.length - 1;
			keycache[key] = keyIndex;
		}
		pbf.writeVarint(keyIndex);

		const type = typeof value;
		if (type !== 'string' && type !== 'boolean' && type !== 'number') {
			value = JSON.stringify(value);
		}
		const valueKey = type + ':' + value;
		let valueIndex = valuecache[valueKey];
		if (typeof valueIndex === 'undefined') {
			values.push(value);
			valueIndex = values.length - 1;
			valuecache[valueKey] = valueIndex;
		}
		pbf.writeVarint(valueIndex);
	}
}

function writeValue(value: any, pbf: Pbf) {
	const type = typeof value;
	if (type === 'string') {
		pbf.writeStringField(1, value);
	} else if (type === 'boolean') {
		pbf.writeBooleanField(7, value);
	} else if (type === 'number') {
		if (value % 1 !== 0) {
			pbf.writeDoubleField(3, value);
		} else if (value < 0) {
			pbf.writeSVarintField(6, value);
		} else {
			pbf.writeVarintField(5, value);
		}
	}
}
