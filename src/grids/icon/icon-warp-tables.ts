// Spring-dynamics warp tables for the ICON icosahedral grids, extracted from
// the official DWD/MPI-M grid files (see icon.ts header): the true positions
// of the level-5 base-lattice vertices plus exact full-resolution patches
// around the 12 pentagon points. One table per root division n, verified to
// transfer across bisection levels (R3B06 with the R3B07 table matches to
// 34 m mean / 0.6 km max). Binary layout (int16 LE): [version, n, tableK,
// baseLevel, patchRadius, quantMm], then the base lattice (20 faces x
// (NB+1)(NB+2)/2 vertices x 2 tangent components), then the pentagon patches
// (20 faces x 3 corners x (P+1)(P+2)/2 x 2). Regenerate with
// icon-native-test/build-warp-table.mts.
//
// The table ships as a separate asset (icon-warp-r3.bin, ~430 KB) instead of
// being embedded in the scripts, which would triple the size of the module and
// the tile worker for every user of the package. GridFactory.preload fetches
// it the first time an ICON grid is needed and registers it here; IconGrid
// constructors then decode it synchronously.

const tables = new Map<number, Int16Array>();
const pending = new Map<number, Promise<void>>();

export const getWarpTable = (n: number): Int16Array | undefined => tables.get(n);

export const hasWarpTable = (n: number): boolean => tables.has(n);

/** Makes the raw table bytes for root division `n` available to IconGrid. */
export const registerWarpTable = (n: number, bytes: ArrayBuffer): void => {
	tables.set(n, new Int16Array(bytes));
};

/**
 * Fetches and registers the table for root division `n` once; concurrent and
 * repeated calls share the same fetch. `urls` maps n to the table asset URL.
 */
export const loadWarpTable = (n: number, urls: Record<number, string>): Promise<void> => {
	if (tables.has(n)) return Promise.resolve();
	let load = pending.get(n);
	if (!load) {
		load = (async () => {
			const url = urls[n];
			if (!url) throw new Error(`No ICON warp table for root division ${n}`);
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`ICON warp table fetch failed (${response.status}): ${url}`);
			}
			registerWarpTable(n, await response.arrayBuffer());
		})().finally(() => pending.delete(n));
		pending.set(n, load);
	}
	return load;
};
