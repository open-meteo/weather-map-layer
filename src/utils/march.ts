import type { Domain } from '../types';

import { lon2tile, lat2tile, tile2lat, tile2lon } from './math';

import type { TypedArray } from '@openmeteo/file-reader';

// prettier-ignore
export const edgeTable = [
	 [],			    // 0
	 [[3, 0]],		 // 1
	 [[0, 1]],               // 2
	 [[3, 1]],               // 3
	 [[1, 2]],               // 4
	 [[3, 0], [1, 2]],    // 5
	 [[0, 1], [1, 2]],    // 6
	 [[3, 2]],               // 7
	 [[2, 3]],               // 8
	 [[0, 2], [2, 3]],     // 9
	 [[1, 3], [2, 3]],     // 10
	 [[0, 3]],               // 11
	 [[1, 3]],               // 12
	 [[0, 1], [1, 3]],     // 13
	 [[0, 3], [1, 2]],     // 14
	 []                         // 15
];

// /**
//  * Intersects a level `T` with a line segment defined by two nodes.
//  *
//  * @param {number} v0   value at the first node
//  * @param {number} v1   value at the second node
//  * @param {number} t0   x (or y) coordinate of the first node
//  * @param {number} t1   coordinate of the second node
//  * @param {number} T    the contour threshold
//  * @returns {number} world coordinate of the intersection
//  */
// function interpolate(
// 	v0: number | bigint,
// 	v1: number | bigint,
// 	t0: number,
// 	t1: number,
// 	threshold: number
// ): number {
// 	if (v0 === v1) return (t0 + t1) * 0.5; // degenerate cell
// 	return t0 + ((threshold - Number(v0)) * (t1 - t0)) / (Number(v1) - Number(v0));
// }

export const marchingSquares = (
	values: TypedArray,
	threshold: number,
	z: number,
	y: number,
	x: number,
	domain: Domain
): number[][] => {
	const segments = [];

	const nx = domain.grid.nx;
	const ny = domain.grid.ny;

	const dx = domain.grid.dx;
	const dy = domain.grid.dy;

	const latMin = domain.grid.latMin;
	const lonMin = domain.grid.lonMin;

	const tileSize = 4096;
	const margin = 256;

	// const minLonTile = tile2lon(x, z);
	// const minLatTile = tile2lat(y, z);
	// const maxLonTile = tile2lon(x + 1, z);
	// const maxLatTile = tile2lat(y + 1, z);

	for (let j = 0; j < ny; j++) {
		const lat = latMin + dy * j;
		// if (lat > minLatTile && lat < maxLatTile) {
		const worldPy = Math.floor(lat2tile(lat, z) * tileSize);
		const py = worldPy - y * tileSize;
		if (py > -margin && py <= tileSize + margin) {
			for (let i = 0; i < nx; i++) {
				const lon = lonMin + dx * i;
				// if (lon > minLonTile && lon < maxLonTile) {
				const worldPx = Math.floor(lon2tile(lon, z) * tileSize);
				const px = worldPx - x * tileSize;
				if (px > -margin && px <= tileSize + margin) {
					const index = j * nx + i;

					/* v3 ------- v2
					 * |      	  |
					 * |      	  |
					 * v0 -------- v1
					 *
					 * v0 = (i, j)
					 * v1 = (i + 1, j)
					 * v2 = (i + 1, j + 1)
					 * v3 = (i, j + 1) */

					const v0 = values[index]; // (i, j)  west‑south, or bottom-left
					const v1 = values[index + 1]; // (i + 1, j)  east‑south, bottom-right
					const v2 = values[index + nx + 1]; // (i + 1, j + 1) east‑north, or top-right
					const v3 = values[index + nx]; //  (i, j + 1) west‑north, or top-left

					const edgeCode =
						(v0 > threshold ? 1 : 0) |
						(v1 > threshold ? 2 : 0) |
						(v2 > threshold ? 4 : 0) |
						(v3 > threshold ? 8 : 0);

					if (edgeCode === 0 || edgeCode === 15) continue; // no contour inside this cell

					// ----- fetch the edges that need intersections -----
					// const edges = edgeTable[edgeCode];

					/* 	 ---------- x1, y1
					 * 	|      	  	|
					 * 	|      	  	|
					 * x0, y0 ----------
					 *
					 * x0 = px
					 * y0 = py
					 * x1 = ... + dx;
					 * y1 = ... + dy */

					// ----- corners of 4 gridcells in tile coordinates -----
					// const x0 = px;
					// const y0 = py;
					// const x1 = Math.floor(lon2tile(lon + dx, z) * tileSize) - x * tileSize;
					// const y1 = Math.floor(lat2tile(lat + dy, z) * tileSize) - y * tileSize;

					// ----- corners of 4 gridcells in wgs84 coordinates -----
					// const x0 = lon;
					// const y0 = lat;
					// const x1 = lon + dx;
					// const y1 = lat + dy;

					/* 	 ---- p2 ----
					 * 	|		|
					 *      p3	      p1
					 * 	|      	  	|
					 * 	 ---- p0 ----   */

					const p0 = [Math.floor(lon2tile(lon + 0.5 * dx, z) * tileSize) - x * tileSize, py];
					const p1 = [
						Math.floor(lon2tile(lon + dx, z) * tileSize) - x * tileSize,
						Math.floor(lat2tile(lat + 0.5 * dy, z) * tileSize) - y * tileSize
					];
					const p2 = [
						Math.floor(lon2tile(lon + 0.5 * dx, z) * tileSize) - x * tileSize,
						Math.floor(lat2tile(lat + 1 * dy, z) * tileSize) - y * tileSize
					];
					const p3 = [px, Math.floor(lat2tile(lat + 0.5 * dy, z) * tileSize) - y * tileSize];

					switch (edgeCode) {
						case 1:
						case 14:
							segments.push([...p3, ...p0]);
							break;

						case 2:
						case 13:
							segments.push([...p0, ...p1]);
							break;

						case 3:
						case 12:
							segments.push([...p3, ...p1]);
							break;

						case 11:
						case 4:
							segments.push([...p2, ...p1]);
							break;

						case 5:
							segments.push([...p0, ...p1]);
							segments.push([...p2, ...p3]);
							break;
						case 6:
						case 9:
							segments.push([...p2, ...p0]);
							break;

						case 7:
						case 8:
							segments.push([...p2, ...p3]);
							break;

						case 10:
							segments.push([...p3, ...p0]);
							segments.push([...p1, ...p2]);
							break;
						default:
							break;
					}
				}
				// 	}
				// }
			}
		}
	}

	return segments;
};
