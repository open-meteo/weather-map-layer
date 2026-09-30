import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegularGridFromBounds } from '../types';

// A fake OM file: children by name with their dimensions and, for crs_wkt,
// the scalar. `OmFileReader.create` opens it, `FileBackend` is a stand-in.
interface FakeChild {
	name: string | null;
	dimensions: number[];
	scalar?: string;
}
const { fakeFiles, created } = vi.hoisted(() => ({
	fakeFiles: new Map<Blob, FakeChild[]>(),
	created: { count: 0 }
}));

vi.mock('@openmeteo/file-reader', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@openmeteo/file-reader')>();
	class FileBackend {
		constructor(public file: Blob) {}
	}
	const childReader = (child: FakeChild) => ({
		getName: () => child.name,
		getDimensions: () => child.dimensions,
		readScalar: () => child.scalar ?? null,
		dispose: vi.fn()
	});
	class OmFileReader {
		constructor(private children: FakeChild[]) {}
		static async create(backend: FileBackend) {
			created.count++;
			return new OmFileReader(fakeFiles.get(backend.file) ?? []);
		}
		numberOfChildren = () => this.children.length;
		getChild = async (i: number) => childReader(this.children[i]);
		getChildByName = async (name: string) => {
			const child = this.children.find((c) => c.name === name);
			return child ? childReader(child) : null;
		};
		dispose = vi.fn();
	}
	return { ...actual, FileBackend, OmFileReader };
});

const WGS84_WKT = `GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563]],CS[ellipsoidal,2],AXIS["latitude",north],AXIS["longitude",east],ANGLEUNIT["degree",0.0174532925199433],USAGE[SCOPE["unknown"],AREA["World"],BBOX[-90,-180,90,180]]]`;

const fileWith = (children: FakeChild[]): Blob => {
	const blob = new Blob(['om']);
	fakeFiles.set(blob, children);
	return blob;
};

const dataFile = () =>
	fileWith([
		{ name: 'crs_wkt', dimensions: [], scalar: WGS84_WKT },
		{ name: 'temperature_2m', dimensions: [721, 1440] },
		{ name: 'lat', dimensions: [721] },
		{ name: 'precipitation', dimensions: [361, 720] }
	]);

beforeEach(() => {
	created.count = 0;
});
afterEach(() => {
	vi.resetModules();
});

describe('registerLocalOmFile', () => {
	it('lists the 2D variables and derives a grid per variable from crs_wkt', async () => {
		const { registerLocalOmFile, getLocalOmFile, isLocalOmUrl } = await import('../local-files');
		const entry = await registerLocalOmFile(dataFile());

		expect(isLocalOmUrl(entry.baseUrl)).toBe(true);
		expect(getLocalOmFile(entry.baseUrl)).toBe(entry);
		expect(entry.variables).toEqual(['temperature_2m', 'precipitation']);
		const t2m = entry.grids.get('temperature_2m') as RegularGridFromBounds;
		expect(t2m.nx).toBe(1440);
		expect(t2m.ny).toBe(721);
		expect(entry.grids.get('precipitation')?.nx).toBe(720);
	});

	it('rejects a file without crs_wkt', async () => {
		const { registerLocalOmFile } = await import('../local-files');
		const file = fileWith([{ name: 'temperature_2m', dimensions: [721, 1440] }]);
		await expect(registerLocalOmFile(file)).rejects.toThrow('crs_wkt');
	});

	it('hands out distinct urls and forgets unregistered files', async () => {
		const { registerLocalOmFile, unregisterLocalOmFile, getLocalOmFile } =
			await import('../local-files');
		const a = await registerLocalOmFile(dataFile());
		const b = await registerLocalOmFile(dataFile());
		expect(a.baseUrl).not.toBe(b.baseUrl);
		unregisterLocalOmFile(a.baseUrl);
		expect(getLocalOmFile(a.baseUrl)).toBeUndefined();
		expect(getLocalOmFile(b.baseUrl)).toBe(b);
	});
});

describe('local file requests', () => {
	it('resolves a local url to a single-file domain carrying the variable grid', async () => {
		const { registerLocalOmFile } = await import('../local-files');
		const { parseRequest } = await import('../utils/parse-request');
		const { defaultOmProtocolSettings } = await import('../om-protocol');
		const entry = await registerLocalOmFile(dataFile());

		const { dataOptions } = parseRequest(
			`om://${entry.baseUrl}?variable=precipitation`,
			defaultOmProtocolSettings
		);
		expect(dataOptions.domain.value).toBe(entry.baseUrl);
		expect(dataOptions.domain.grid).toBe(entry.grids.get('precipitation'));
		expect(dataOptions.variable).toBe('precipitation');

		expect(() =>
			parseRequest(`om://${entry.baseUrl}?variable=wind_speed_10m`, defaultOmProtocolSettings)
		).toThrow('not found in local file');
	});

	it('opens the registered file for reads instead of an HTTP backend', async () => {
		const { registerLocalOmFile } = await import('../local-files');
		const { WeatherMapLayerFileReader } = await import('../om-file-reader');
		const entry = await registerLocalOmFile(dataFile());
		const reader = new WeatherMapLayerFileReader();
		const opened = created.count;

		// The fake children can't serve data; reaching the child lookup proves
		// the read went through a FileBackend reader on the registered file
		await expect(reader.readVariable(entry.baseUrl, 'temperature_2m', null)).rejects.toThrow();
		expect(created.count).toBe(opened + 1);
	});
});
