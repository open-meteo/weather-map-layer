import type { PackageAssets } from './types';

let packageAssets: PackageAssets | undefined;

/**
 * URLs of the runtime assets shipped next to the module. They are resolved by
 * the main thread (see worker-pool.ts) and handed to the tile workers, which
 * cannot resolve them from their own location: bundlers that consume this
 * package relocate the worker script and the assets independently.
 */
export const getPackageAssets = (): PackageAssets => {
	if (!packageAssets) {
		throw new Error('Package asset URLs are not resolved on this thread');
	}
	return packageAssets;
};

export const setPackageAssets = (assets: PackageAssets): void => {
	packageAssets = assets;
};
