/**
 * Station-model wind barbs: a staff pointing into the wind, with pennants
 * (50 kt), full barbs (10 kt) and half barbs (5 kt) at its upwind end.
 *
 * Written into the same `wind-arrows` layer as `generateArrows` and carrying
 * the same `value`/`direction` properties, so consumers style both the same
 * way and only the geometry differs.
 *
 * Unlike a printed station plot, the whole assembly is kept inside its lattice
 * cell: the staff is shorter than the cell and the barb spacing shrinks when a
 * strong wind needs many of them, so neighbouring barbs never run into each
 * other.
 */
import { GridInterface } from '../grids';
import { PbfWriter } from 'pbf';

import { type ResolvedClippingOptions, createClippingTester } from './clipping';
import { BARB_LATTICE, VECTOR_TILE_EXTENT } from './constants';
import { degreesToRadians, rotatePoint, tile2lat, tile2lon } from './math';
import { command, writeLayer, zigzag } from './pbf';

import { InterpolationMethod } from '../types';

const MS_TO_KNOTS = 1.9438445;

/**
 * Below this the plot is a calm circle. Between it and 2.5 kt the rounding in
 * `barbCounts` leaves no barbs, so the staff is drawn bare, as on the chart.
 */
const CIRCLE_KNOTS = 0.5;

// Geometry in units of the lattice spacing `size`, in the proportions of a
// printed station plot: a barb is about a third of the staff and leans out
// toward the staff's end, roughly 60° off it.
/** Half the staff length. */
const STAFF_HALF = 0.42;
/**
 * Preferred distance between two barbs along the staff. Wide enough that the
 * barbs stay apart at the line width the arrows layer draws them with.
 */
const SLOT_STEP = 0.16;
/** Length of the staff that may carry barbs. */
const BARB_SPAN = 0.64;
/** How far a full barb reaches out from the staff. */
const BARB_LENGTH = 0.26;
/** How far a barb tip leans past its root, toward the end of the staff. */
const BARB_LEAN = 0.13;
/** Radius of the calm circle, and of the ring drawn inside it. */
const CALM_RADIUS = 0.17;
const CALM_INNER_RADIUS = 0.11;

/**
 * The whole plot is shrunk to fit within this radius of its lattice point, so
 * neighbouring barbs can never touch whatever the wind does. The outermost
 * barb tip is what sticks out furthest.
 */
const CELL_BUDGET = 0.47;
const FIT = Math.min(1, CELL_BUDGET / Math.hypot(STAFF_HALF + BARB_LEAN, BARB_LENGTH));

/**
 * A closed ring as vector-tile geometry: MoveTo, one LineTo for the rest,
 * ClosePath. Exterior rings have to wind so their area is positive in tile
 * coordinates, which depends on the wind direction here, so the ring is
 * reversed when it comes out the other way round.
 */
const ringGeometry = (ring: number[][]): number[] => {
	let area = 0;
	for (let i = 0; i < ring.length; i++) {
		const next = ring[(i + 1) % ring.length];
		area += ring[i][0] * next[1] - next[0] * ring[i][1];
	}
	const points = area < 0 ? [...ring].reverse() : ring;

	const geom = [command(1, 1)];
	let cursor = [0, 0];
	for (let i = 0; i < points.length; i++) {
		if (i === 1) geom.push(command(2, points.length - 1));
		geom.push(zigzag(points[i][0] - cursor[0]));
		geom.push(zigzag(points[i][1] - cursor[1]));
		cursor = points[i];
	}
	geom.push(command(7, 1)); // ClosePath
	return geom;
};

/** Pennants, full barbs and half barbs for a speed, rounded to 5 kt. */
const barbCounts = (knots: number): { pennants: number; full: number; half: number } => {
	let remaining = Math.round(knots / 5) * 5;
	const pennants = Math.floor(remaining / 50);
	remaining -= pennants * 50;
	const full = Math.floor(remaining / 10);
	remaining -= full * 10;
	return { pennants, full, half: remaining >= 5 ? 1 : 0 };
};

export const generateWindBarbs = (
	pbf: PbfWriter,
	values: Float32Array,
	directions: Float32Array,
	grid: GridInterface,
	x: number,
	y: number,
	z: number,
	clippingOptions: ResolvedClippingOptions | undefined,
	interpolation: InterpolationMethod = 'linear',
	extent: number = VECTOR_TILE_EXTENT,
	barbs: number = BARB_LATTICE
) => {
	// The world tiles stay denser, for the same reason `generateArrows` does
	if (z === 0) {
		barbs = 36;
	}
	if (z === 1) {
		barbs = 28;
	}

	const features = [];
	// Pennants go into their own polygon layer so they can be drawn solid; the
	// outline below keeps them visible to anything styling only the lines
	const pennantFeatures = [];
	const size = extent / barbs;
	const isInsideClip = createClippingTester(clippingOptions);

	// Stepped by index rather than by accumulating `size`, which drifts. The
	// far edge is included: a shape there is clipped to its own tile, and the
	// neighbouring tile draws the other half of it.
	for (let row = 0; row <= barbs; row++) {
		const tileY = (row * extent) / barbs;
		const lat = tile2lat(y + tileY / extent, z);
		for (let column = 0; column <= barbs; column++) {
			const tileX = (column * extent) / barbs;
			const lon = tile2lon(x + tileX / extent, z);

			if (isInsideClip && !isInsideClip(lon, lat)) {
				continue;
			}

			const speed = grid.getInterpolatedValue(values, lat, lon, interpolation);
			const knots = speed * MS_TO_KNOTS;
			if (!isFinite(knots)) {
				continue;
			}

			// The staff points at where the wind comes from, so the rotation is the
			// direction as is (an arrow adds 180° to point the other way)
			const rotation = degreesToRadians(grid.getLinearInterpolatedDirection(directions, lat, lon));
			// The `direction` property keeps the arrow convention (downwind, i.e.
			// direction + 180°) so consumers see the same value whatever the
			// `arrow_style`; only the geometry uses the upwind rotation.
			const direction = rotation + Math.PI;
			const centre = [tileX, tileY];
			// Barbs sit on the left of the staff, mirrored south of the equator
			const side = lat >= 0 ? 1 : -1;

			// Local frame: the staff runs up the y axis, the end carrying the
			// barbs at -STAFF_HALF. Rounded here so the deltas below stay exact
			// once zigzagged.
			const point = (across: number, along: number): number[] => {
				const [px, py] = rotatePoint(
					centre[0],
					centre[1],
					rotation,
					centre[0] + across * FIT * size * side,
					centre[1] + along * FIT * size
				);
				return [Math.round(px), Math.round(py)];
			};

			const geom: number[] = [];
			let cursor = [0, 0];
			const moveTo = (p: number[]): void => {
				geom.push(command(1, 1));
				geom.push(zigzag(p[0] - cursor[0]));
				geom.push(zigzag(p[1] - cursor[1]));
				cursor = p;
			};
			const lineTo = (p: number[]): void => {
				geom.push(command(2, 1));
				geom.push(zigzag(p[0] - cursor[0]));
				geom.push(zigzag(p[1] - cursor[1]));
				cursor = p;
			};

			if (knots < CIRCLE_KNOTS) {
				// Calm: a ring inside a ring, where the staff would start
				const corners = 12;
				for (const radius of [CALM_RADIUS, CALM_INNER_RADIUS]) {
					for (let i = 0; i <= corners; i++) {
						const angle = (i / corners) * 2 * Math.PI;
						const p = point(radius * Math.sin(angle), radius * Math.cos(angle));
						if (i === 0) moveTo(p);
						else lineTo(p);
					}
				}
			} else {
				// Staff, drawn from the downwind end into the wind
				moveTo(point(0, STAFF_HALF));
				lineTo(point(0, -STAFF_HALF));
			}

			const { pennants, full, half } = barbCounts(knots);
			// A pennant is as wide as it is tall, so it takes two slots. A lone
			// half barb is set one slot in from the end, as it is when printed.
			const lonely = half === 1 && pennants === 0 && full === 0;
			const slots = pennants * 2 + full + half + (lonely ? 1 : 0);
			const step = Math.min(SLOT_STEP, BARB_SPAN / Math.max(1, slots));

			// Barbs from the end of the staff inward, strongest first. Their
			// tips lean out past their root, away from the middle of the staff.
			let along = -STAFF_HALF + (lonely ? step : 0);
			for (let i = 0; i < pennants; i++) {
				const ring = [
					point(0, along),
					point(BARB_LENGTH, along - BARB_LEAN),
					point(0, along + 2 * step)
				];
				moveTo(ring[0]);
				lineTo(ring[1]);
				lineTo(ring[2]);
				pennantFeatures.push({
					id: tileX + tileY + i,
					type: 3, // 3 = Polygon
					properties: { value: speed, direction },
					geom: ringGeometry(ring)
				});
				along += 2 * step;
			}
			for (let i = 0; i < full; i++) {
				moveTo(point(0, along));
				lineTo(point(BARB_LENGTH, along - BARB_LEAN));
				along += step;
			}
			if (half) {
				moveTo(point(0, along));
				lineTo(point(BARB_LENGTH / 2, along - BARB_LEAN / 2));
			}

			features.push({
				id: tileX + tileY,
				type: 2, // 2 = LineString
				properties: { value: speed, direction },
				geom: geom
			});
		}
	}

	// write Layer
	pbf.writeMessage(3, writeLayer, {
		name: 'wind-arrows',
		extent,
		features
	});

	if (pennantFeatures.length) {
		pbf.writeMessage(3, writeLayer, {
			name: 'wind-barb-pennants',
			extent,
			features: pennantFeatures
		});
	}
};
