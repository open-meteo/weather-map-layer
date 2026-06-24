/**
 * Registry for locally provided OM files (e.g. drag-and-dropped by the user).
 *
 * Files are stored in-memory and addressed through a synthetic base url of the
 * form `local/<uuid>`. This is the same `baseUrl` that `parseUrlComponents`
 * yields for an `om://local/<uuid>?variable=...` url, so the protocol can detect
 * the local case and read the file through a `FileBackend` instead of HTTP.
 */

const LOCAL_PREFIX = 'local/';

const localFiles = new Map<string, File | Blob>();

const randomId = (): string => {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

/** True when the given base url refers to a locally registered OM file. */
export const isLocalOmUrl = (baseUrl: string): boolean => baseUrl.startsWith(LOCAL_PREFIX);

/**
 * Register a local OM file and return its synthetic base url (`local/<uuid>`).
 * Build a full protocol url by appending query params, e.g.
 * `om://${base}?variable=temperature_2m`.
 */
export const registerLocalOmFile = (file: File | Blob): string => {
	const baseUrl = `${LOCAL_PREFIX}${randomId()}`;
	localFiles.set(baseUrl, file);
	return baseUrl;
};

/** Look up a registered local file by its base url. */
export const getLocalOmFile = (baseUrl: string): File | Blob | undefined => localFiles.get(baseUrl);

/** Remove a previously registered local file. */
export const unregisterLocalOmFile = (baseUrl: string): void => {
	localFiles.delete(baseUrl);
};
