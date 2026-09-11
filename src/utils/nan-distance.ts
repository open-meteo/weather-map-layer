/**
 * Two-pass chamfer distance transform: for every cell, the approximate distance
 * (in degrees) to the nearest NaN ("no data") cell.
 *
 * Reprojected domains stored on a regular lat/lon grid (e.g. DWD ICON-D2 or
 * MF AROME France) fill the area around their real shape with NaN. Measuring the
 * distance to that NaN lets the seamless blend fade across the *real* data
 * boundary instead of the rectangular grid box.
 *
 * Returns `undefined` when the data contains no NaN (nothing to fade against),
 * so callers can cheaply skip non-padded grids.
 */
export const computeNanDistanceField = (
	values: Float32Array,
	nx: number,
	ny: number,
	dx: number,
	dy: number
): Float32Array | undefined => {
	const n = nx * ny;
	if (values.length < n) return undefined;

	// Gate: grids without missing data need no field.
	let hasNan = false;
	for (let i = 0; i < n; i++) {
		if (Number.isNaN(values[i])) {
			hasNan = true;
			break;
		}
	}
	if (!hasNan) return undefined;

	const hx = Math.abs(dx); // horizontal step in degrees (lon)
	const hy = Math.abs(dy); // vertical step in degrees (lat)
	const hd = Math.hypot(hx, hy); // diagonal step
	const INF = 1e9;

	const dist = new Float32Array(n);
	for (let i = 0; i < n; i++) dist[i] = Number.isNaN(values[i]) ? 0 : INF;

	// Forward pass (top-left → bottom-right).
	for (let y = 0; y < ny; y++) {
		for (let x = 0; x < nx; x++) {
			const i = y * nx + x;
			let d = dist[i];
			if (d === 0) continue;
			if (x > 0) d = Math.min(d, dist[i - 1] + hx);
			if (y > 0) d = Math.min(d, dist[i - nx] + hy);
			if (x > 0 && y > 0) d = Math.min(d, dist[i - nx - 1] + hd);
			if (x < nx - 1 && y > 0) d = Math.min(d, dist[i - nx + 1] + hd);
			dist[i] = d;
		}
	}

	// Backward pass (bottom-right → top-left).
	for (let y = ny - 1; y >= 0; y--) {
		for (let x = nx - 1; x >= 0; x--) {
			const i = y * nx + x;
			let d = dist[i];
			if (x < nx - 1) d = Math.min(d, dist[i + 1] + hx);
			if (y < ny - 1) d = Math.min(d, dist[i + nx] + hy);
			if (x < nx - 1 && y < ny - 1) d = Math.min(d, dist[i + nx + 1] + hd);
			if (x > 0 && y < ny - 1) d = Math.min(d, dist[i + nx - 1] + hd);
			dist[i] = d;
		}
	}

	return dist;
};
