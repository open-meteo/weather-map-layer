/**
 * Eastward/northward wind components from the protocol's speed + direction
 * arrays (direction = where the wind comes from, so the flow bearing is
 * +180°). A pure loop with no GL dependencies, so the decode worker can run
 * it off the main thread; the particle pass's `windComponentsOf` wraps it
 * with the identity cache.
 */
export const deriveWindComponents = (
	values: Float32Array,
	directions: Float32Array
): { u: Float32Array; v: Float32Array } => {
	const n = values.length;
	// Match the source arrays' backing (SharedArrayBuffer when SAB is on), so
	// worker-derived components post back zero-copy like the values do.
	const BufferConstructor = values.buffer.constructor as typeof ArrayBuffer;
	const u = new Float32Array(new BufferConstructor(n * 4));
	const v = new Float32Array(new BufferConstructor(n * 4));
	for (let i = 0; i < n; i++) {
		const speed = values[i];
		const direction = directions[i];
		if (!isFinite(speed) || !isFinite(direction)) {
			u[i] = NaN;
			v[i] = NaN;
			continue;
		}
		const bearing = ((direction + 180) * Math.PI) / 180;
		u[i] = speed * Math.sin(bearing);
		v[i] = speed * Math.cos(bearing);
	}
	return { u, v };
};
