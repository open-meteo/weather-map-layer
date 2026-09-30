/**
 * Registry for OM files the page provides itself (drag-and-drop, a file
 * picker) instead of fetching from a server. A registered file is addressed
 * by a synthetic base url `local/<id>`, so a protocol url looks like
 * `om://local/<id>?variable=temperature_2m`; the reader and the request
 * resolver recognise the prefix and read the file from memory.
 *
 * Such a file carries no domain identity, so its grid comes from the file's
 * own `crs_wkt` child (a WKT2 CRS) plus each variable's dimensions. Both are
 * read once, on registration, which keeps the request path synchronous.
 */
import { FileBackend, OmDataType, OmFileReader } from '@openmeteo/file-reader';

import { wktToGridData } from './utils/wkt';

import type { GridData } from './types';

export interface LocalOmFile {
	/** Synthetic base url, `local/<id>`. */
	baseUrl: string;
	file: File | Blob;
	/** The 2D data variables in the file, in file order (`crs_wkt` excluded). */
	variables: string[];
	/** Grid per variable; variables of one file can differ in dimensions. */
	grids: Map<string, GridData>;
}

const LOCAL_PREFIX = 'local/';

const localFiles = new Map<string, LocalOmFile>();
// Ids only need to be unique within the page; a counter never repeats one
let nextId = 0;

/** True for the `local/<id>` base url of a registered file. */
export const isLocalOmUrl = (baseUrl: string): boolean => baseUrl.startsWith(LOCAL_PREFIX);

/** The registered file behind `baseUrl`, if any. */
export const getLocalOmFile = (baseUrl: string): LocalOmFile | undefined => localFiles.get(baseUrl);

/**
 * Read a file's variables and grids and register it. Rejects when the file
 * has no `crs_wkt` child, since it could not be placed on the map.
 */
export const registerLocalOmFile = async (file: File | Blob): Promise<LocalOmFile> => {
	const reader = await OmFileReader.create(new FileBackend(file));
	try {
		const crs = await reader.getChildByName('crs_wkt');
		const wkt = crs?.readScalar<string>(OmDataType.String);
		crs?.dispose();
		if (!wkt) {
			throw new Error('OM file has no crs_wkt child, so its grid is unknown');
		}

		const variables: string[] = [];
		const grids = new Map<string, GridData>();
		for (let i = 0; i < reader.numberOfChildren(); i++) {
			const child = await reader.getChild(i);
			if (!child) continue;
			const name = child.getName();
			const dimensions = child.getDimensions();
			child.dispose();
			if (!name || name === 'crs_wkt' || dimensions.length !== 2) continue;
			const [ny, nx] = dimensions;
			variables.push(name);
			grids.set(name, wktToGridData(wkt, nx, ny));
		}

		const entry: LocalOmFile = { baseUrl: `${LOCAL_PREFIX}${++nextId}`, file, variables, grids };
		localFiles.set(entry.baseUrl, entry);
		return entry;
	} finally {
		reader.dispose();
	}
};

/** Forget a registered file; pending reads of it keep their own reference. */
export const unregisterLocalOmFile = (baseUrl: string): void => {
	localFiles.delete(baseUrl);
};
