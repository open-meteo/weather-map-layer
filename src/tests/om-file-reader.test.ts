import { WeatherMapLayerFileReader } from '../om-file-reader';
import { OmDataType } from '@openmeteo/file-reader';
import { describe, expect, it, vi } from 'vitest';

/** dwd_icon_d2 as the server writes it: 1215 x 746 points, 0.02 degrees. */
const WKT = `GEOGCRS["WGS 84",
    DATUM["World Geodetic System 1984",
        ELLIPSOID["WGS 84",6378137,298.257223563]],
    CS[ellipsoidal,2],
        AXIS["latitude",north],
        AXIS["longitude",east],
        ANGLEUNIT["degree",0.0174532925199433]
    USAGE[
        SCOPE["grid"],
        BBOX[43.18,-3.94,58.08,20.339998]]]`;

interface FakeChild {
	getDimensions: () => number[];
	readScalar: (type: OmDataType) => unknown;
	dispose: () => void;
}

/** An om file with the given children; records which children get disposed. */
const fakeFile = (children: Record<string, Partial<FakeChild>>) => {
	const disposed: string[] = [];
	const reader = {
		getChildByName: vi.fn(async (name: string): Promise<FakeChild | null> =>
			name in children
				? {
						getDimensions: () => [],
						readScalar: () => null,
						dispose: () => {
							disposed.push(name);
						},
						...children[name]
					}
				: null
		)
	};
	return { reader, disposed };
};

const scalar = (value: string): Partial<FakeChild> => ({
	readScalar: (type) => (type === OmDataType.String ? value : null)
});
const array = (dimensions: number[]): Partial<FakeChild> => ({ getDimensions: () => dimensions });

type FakeReader = ReturnType<typeof fakeFile>['reader'];

/** Route the reader's file opens to a fake file instead of HTTP. */
const openFake = (reader: WeatherMapLayerFileReader, file: FakeReader) => {
	const withReader = vi.fn(
		(_url: string, _cache: unknown, fn: (r: FakeReader) => Promise<unknown>) => fn(file)
	);
	(reader as unknown as { backendPool: { withReader: typeof withReader } }).backendPool = {
		withReader
	};
	return withReader;
};

const URL_A = 'https://example.com/data_spatial/dwd_icon_d2/a.om';
const URL_B = 'https://example.com/data_spatial/dwd_icon_d2/b.om';

describe('WeatherMapLayerFileReader.readGridData', () => {
	it('derives the grid from the variable dimensions and the crs_wkt attribute', async () => {
		const reader = new WeatherMapLayerFileReader();
		const file = fakeFile({ temperature_2m: array([746, 1215]), crs_wkt: scalar(WKT) });
		openFake(reader, file.reader);

		const grid = await reader.readGridData(URL_A, 'temperature_2m');

		expect(grid).toEqual({
			type: 'regular',
			nx: 1215,
			ny: 746,
			latitude: [43.18, 58.08],
			longitude: [-3.94, 20.339998]
		});
		expect(file.disposed).toEqual(['temperature_2m', 'crs_wkt']);
	});

	it('takes the dimensions from the primary source of a derived variable', async () => {
		const reader = new WeatherMapLayerFileReader();
		// Direction derives from speed + direction; only those two are stored.
		const file = fakeFile({
			wind_speed_10m: array([564, 676]),
			wind_direction_10m: array([564, 676]),
			crs_wkt: scalar(WKT)
		});
		openFake(reader, file.reader);

		const grid = await reader.readGridData(URL_A, 'wind_direction_10m');

		expect(grid).toMatchObject({ nx: 676, ny: 564 });
		expect(file.reader.getChildByName).toHaveBeenCalledWith('wind_speed_10m');
		expect(file.reader.getChildByName).not.toHaveBeenCalledWith('wind_direction_10m');
	});

	it('memoizes the grid per file URL', async () => {
		const reader = new WeatherMapLayerFileReader();
		const file = fakeFile({ temperature_2m: array([746, 1215]), crs_wkt: scalar(WKT) });
		const withReader = openFake(reader, file.reader);

		const first = await reader.readGridData(URL_A, 'temperature_2m');
		const second = await reader.readGridData(URL_A, 'temperature_2m');
		await reader.readGridData(URL_B, 'temperature_2m');

		expect(second).toBe(first);
		expect(withReader).toHaveBeenCalledTimes(2);
	});

	it('does not keep failures', async () => {
		const reader = new WeatherMapLayerFileReader();
		openFake(reader, fakeFile({ temperature_2m: array([746, 1215]) }).reader);

		await expect(reader.readGridData(URL_A, 'temperature_2m')).rejects.toThrow('No crs_wkt');

		const withReader = openFake(
			reader,
			fakeFile({ temperature_2m: array([746, 1215]), crs_wkt: scalar(WKT) }).reader
		);
		await expect(reader.readGridData(URL_A, 'temperature_2m')).resolves.toMatchObject({
			nx: 1215
		});
		expect(withReader).toHaveBeenCalledTimes(1);
	});

	it('rejects variables that are not two-dimensional', async () => {
		const reader = new WeatherMapLayerFileReader();
		openFake(reader, fakeFile({ valid_time: array([48]), crs_wkt: scalar(WKT) }).reader);

		await expect(reader.readGridData(URL_A, 'valid_time')).rejects.toThrow('not a 2D grid');
	});

	it('rejects variables the file does not contain', async () => {
		const reader = new WeatherMapLayerFileReader();
		openFake(reader, fakeFile({ crs_wkt: scalar(WKT) }).reader);

		await expect(reader.readGridData(URL_A, 'temperature_2m')).rejects.toThrow('not found');
	});
});
