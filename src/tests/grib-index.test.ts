import { gfsCompanionIndexUrls, gfsGribVariable, gfsStoredVariables } from '../grib/gfs';
import { findGribRecord, gribRecordRange, gribStepKind, parseGribIndex } from '../grib/grib-index';
import { describe, expect, it } from 'vitest';

const INDEX = `1:0:d=2026102700:PRMSL:mean sea level:3 hour fcst:
2:988044:d=2026102700:TMP:2 m above ground:3 hour fcst:
3:1074557:d=2026102700:UGRD:10 m above ground:3 hour fcst:
4:1361035:d=2026102700:VGRD:10 m above ground:3 hour fcst:
5:1590445:d=2026102700:TCDC:entire atmosphere:3 hour fcst:
6:1685790:d=2026102700:TCDC:entire atmosphere:0-3 hour ave fcst:
7:1726911:d=2026102700:PRATE:surface:0-3 hour ave fcst:
8:2526369:d=2026102700:TMP:850 mb:3 hour fcst:
9:3325948:d=2026102700:DZDT:500 mb:3 hour fcst:
`;

describe('parseGribIndex', () => {
	const records = parseGribIndex(INDEX);

	it('reads one record per line with its offset, name, level and step', () => {
		expect(records).toHaveLength(9);
		expect(records[1]).toEqual({
			offset: 988044,
			end: 1074556,
			name: 'TMP',
			level: '2 m above ground',
			step: '3 hour fcst'
		});
	});

	it('ends each message where the next begins, the last one open', () => {
		expect(records[0].end).toBe(988043);
		expect(records[8].end).toBeUndefined();
	});

	it('skips blank and malformed lines', () => {
		expect(parseGribIndex('\n1:0:d=2026102700:TMP\n\n')).toEqual([]);
	});

	it('formats the byte range of a record', () => {
		expect(gribRecordRange(records[1])).toBe('bytes=988044-1074556');
		expect(gribRecordRange(records[8])).toBe('bytes=3325948-');
	});
});

describe('gribStepKind', () => {
	it('classifies the step descriptions NCEP writes', () => {
		expect(gribStepKind('anl')).toBe('instant');
		expect(gribStepKind('3 hour fcst')).toBe('instant');
		expect(gribStepKind('15 min fcst')).toBe('instant');
		expect(gribStepKind('0-3 hour ave fcst')).toBe('average');
		expect(gribStepKind('120-123 hour acc fcst')).toBe('accumulation');
		expect(gribStepKind('6-7 hour max fcst')).toBe('maximum');
		expect(gribStepKind('6-7 hour min fcst')).toBe('minimum');
		expect(gribStepKind('something else')).toBeUndefined();
	});
});

describe('findGribRecord', () => {
	const records = parseGribIndex(INDEX);

	it('takes the first step kind the index has, in the order asked', () => {
		expect(findGribRecord(records, 'TCDC', 'entire atmosphere', ['instant', 'average'])?.step).toBe(
			'3 hour fcst'
		);
		expect(findGribRecord(records, 'TCDC', 'entire atmosphere', ['average', 'instant'])?.step).toBe(
			'0-3 hour ave fcst'
		);
		expect(findGribRecord(records, 'PRATE', 'surface', ['instant', 'average'])?.step).toBe(
			'0-3 hour ave fcst'
		);
	});

	it('is undefined for a name, level or step kind the index lacks', () => {
		expect(findGribRecord(records, 'TMP', '80 m above ground', ['instant'])).toBeUndefined();
		expect(findGribRecord(records, 'PRATE', 'surface', ['instant'])).toBeUndefined();
	});
});

describe('gfsGribVariable', () => {
	it('maps surface variables with their unit conversion', () => {
		expect(gfsGribVariable('temperature_2m')).toEqual({
			name: 'TMP',
			level: '2 m above ground',
			add: -273.15
		});
		expect(gfsGribVariable('precipitation')).toMatchObject({
			name: 'PRATE',
			multiply: 3600,
			steps: ['instant', 'average']
		});
		expect(gfsGribVariable('wind_v_component_80m')).toEqual({
			name: 'VGRD',
			level: '80 m above ground'
		});
		expect(gfsGribVariable('soil_moisture_10_to_40cm')).toEqual({
			name: 'SOILW',
			level: '0.1-0.4 m below ground'
		});
	});

	it('maps pressure level variables to their level in mb', () => {
		expect(gfsGribVariable('temperature_850hPa')).toEqual({
			name: 'TMP',
			level: '850 mb',
			add: -273.15
		});
		expect(gfsGribVariable('vertical_velocity_500hPa')).toEqual({ name: 'DZDT', level: '500 mb' });
		expect(gfsGribVariable('geopotential_height_1000hPa')).toEqual({
			name: 'HGT',
			level: '1000 mb'
		});
	});

	it('knows no record for derived or foreign variables', () => {
		expect(gfsGribVariable('wind_speed_10m')).toBeUndefined();
		expect(gfsGribVariable('pm2_5')).toBeUndefined();
		expect(gfsGribVariable('pm2_5_850hPa')).toBeUndefined();
	});
});

describe('gfsStoredVariables', () => {
	it('lists the Open-Meteo names an index has records for', () => {
		const stored = gfsStoredVariables(parseGribIndex(INDEX));
		expect([...stored].sort()).toEqual([
			'cloud_cover',
			'precipitation',
			'temperature_2m',
			'temperature_850hPa',
			'vertical_velocity_500hPa',
			'wind_u_component_10m',
			'wind_v_component_10m'
		]);
	});
});

describe('gfsCompanionIndexUrls', () => {
	it('pairs the 0.25° pgrb2 index with its pgrb2b index', () => {
		expect(
			gfsCompanionIndexUrls(
				'https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261027/00/atmos/gfs.t00z.pgrb2.0p25.f003.idx'
			)
		).toEqual([
			'https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261027/00/atmos/gfs.t00z.pgrb2b.0p25.f003.idx'
		]);
	});

	it('has none for the surface flux product', () => {
		expect(gfsCompanionIndexUrls('https://example.com/gfs.t00z.sfluxgrbf003.grib2.idx')).toEqual(
			[]
		);
	});
});
