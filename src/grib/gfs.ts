/**
 * How Open-Meteo's variable names map onto the records of NOAA's GFS GRIB2
 * products, the same way the open-meteo downloader reads them
 * (`Sources/App/Gfs/GfsVariableDownloadable.swift`):
 *
 *   - `pgrb2.0p25` / `pgrb2b.0p25`: the 0.25° output (`ncep_gfs025`), surface
 *     and pressure-level fields; the `b` file holds further pressure levels
 *   - `sfluxgrbf`: the surface fluxes on the native ~0.117° Gaussian grid
 *     (`ncep_gfs013`), surface fields only
 *
 * Both products name their records alike, so one table serves both; a name
 * a product does not write is simply not found in its index.
 */
import type { GribIndexRecord, GribStepKind } from './grib-index';

/** The record a variable is read from, and how its unit becomes Open-Meteo's. */
export interface GfsGribVariable {
	/** Parameter abbreviation in the index, e.g. `TMP`. */
	name: string;
	/** Level description in the index, e.g. `2 m above ground`. */
	level: string;
	/**
	 * Step kinds to accept, in order of preference. Instantaneous unless set:
	 * fields a product only writes as period statistics (fluxes, cloud cover
	 * in the surface flux files) list the statistic.
	 */
	steps?: GribStepKind[];
	/** Unit conversion `value * multiply + add`, applied after decoding. */
	multiply?: number;
	add?: number;
}

const KELVIN: Pick<GfsGribVariable, 'add'> = { add: -273.15 };
const PASCAL: Pick<GfsGribVariable, 'multiply'> = { multiply: 0.01 };
// kg/m²/s is mm/s, so an hourly rate is the record times 3600
const PER_SECOND_RATE: Pick<GfsGribVariable, 'multiply' | 'steps'> = {
	multiply: 3600,
	steps: ['instant', 'average']
};
const INSTANT_OR_AVERAGE: Pick<GfsGribVariable, 'steps'> = { steps: ['instant', 'average'] };
const AVERAGE_OR_INSTANT: Pick<GfsGribVariable, 'steps'> = { steps: ['average', 'instant'] };

const SOIL_LAYERS: [suffix: string, level: string][] = [
	['0_to_10cm', '0-0.1 m below ground'],
	['10_to_40cm', '0.1-0.4 m below ground'],
	['40_to_100cm', '0.4-1 m below ground'],
	['100_to_200cm', '1-2 m below ground']
];

const HEIGHTS = ['10m', '80m', '100m'];

const GFS_SURFACE_VARIABLES: Record<string, GfsGribVariable> = {
	temperature_2m: { name: 'TMP', level: '2 m above ground', ...KELVIN },
	temperature_80m: { name: 'TMP', level: '80 m above ground', ...KELVIN },
	temperature_100m: { name: 'TMP', level: '100 m above ground', ...KELVIN },
	surface_temperature: { name: 'TMP', level: 'surface', ...KELVIN },
	dew_point_2m: { name: 'DPT', level: '2 m above ground', ...KELVIN },
	apparent_temperature: { name: 'APTMP', level: '2 m above ground', ...KELVIN },
	relative_humidity_2m: { name: 'RH', level: '2 m above ground' },
	// The membrane-reduced sea level pressure, as the open-meteo API serves it
	pressure_msl: { name: 'MSLET', level: 'mean sea level', ...PASCAL },
	surface_pressure: { name: 'PRES', level: 'surface', ...PASCAL },

	cloud_cover: { name: 'TCDC', level: 'entire atmosphere', ...INSTANT_OR_AVERAGE },
	cloud_cover_low: { name: 'LCDC', level: 'low cloud layer', ...INSTANT_OR_AVERAGE },
	cloud_cover_mid: { name: 'MCDC', level: 'middle cloud layer', ...INSTANT_OR_AVERAGE },
	cloud_cover_high: { name: 'HCDC', level: 'high cloud layer', ...INSTANT_OR_AVERAGE },

	wind_gusts_10m: { name: 'GUST', level: 'surface' },
	...Object.fromEntries(
		HEIGHTS.flatMap((height) => [
			[
				`wind_u_component_${height}`,
				{ name: 'UGRD', level: `${height.slice(0, -1)} m above ground` }
			],
			[
				`wind_v_component_${height}`,
				{ name: 'VGRD', level: `${height.slice(0, -1)} m above ground` }
			]
		])
	),

	// GFS writes precipitation as a rate, so the hourly value needs no time
	// step and the per-step sums of the `.om` files are not involved
	precipitation: { name: 'PRATE', level: 'surface', ...PER_SECOND_RATE },
	showers: { name: 'CPRAT', level: 'surface', ...PER_SECOND_RATE },
	frozen_precipitation_percent: { name: 'CPOFP', level: 'surface' },
	categorical_freezing_rain: { name: 'CFRZR', level: 'surface', ...INSTANT_OR_AVERAGE },
	snow_depth: { name: 'SNOD', level: 'surface' },
	snow_depth_water_equivalent: { name: 'WEASD', level: 'surface' },

	...Object.fromEntries(
		SOIL_LAYERS.flatMap(([suffix, level]) => [
			[`soil_temperature_${suffix}`, { name: 'TSOIL', level, ...KELVIN }],
			[`soil_moisture_${suffix}`, { name: 'SOILW', level }]
		])
	),

	cape: { name: 'CAPE', level: 'surface' },
	convective_inhibition: { name: 'CIN', level: 'surface', multiply: -1 },
	lifted_index: { name: 'LFTX', level: 'surface' },
	freezing_level_height: { name: 'HGT', level: '0C isotherm' },
	visibility: { name: 'VIS', level: 'surface' },
	boundary_layer_height: { name: 'HPBL', level: 'surface' },
	total_column_integrated_water_vapour: {
		name: 'PWAT',
		level: 'entire atmosphere (considered as a single layer)'
	},

	// Fluxes are averages over the period before the valid time
	shortwave_radiation: { name: 'DSWRF', level: 'surface', ...AVERAGE_OR_INSTANT },
	diffuse_radiation: { name: 'VDDSF', level: 'surface', ...AVERAGE_OR_INSTANT },
	sensible_heat_flux: { name: 'SHTFL', level: 'surface', ...AVERAGE_OR_INSTANT },
	latent_heat_flux: { name: 'LHTFL', level: 'surface', ...AVERAGE_OR_INSTANT },
	// UV-B irradiance to UV index, the factor the open-meteo API applies
	uv_index: { name: 'DUVB', level: 'surface', multiply: 18.9 * 0.025, ...AVERAGE_OR_INSTANT },
	uv_index_clear_sky: {
		name: 'CDUVB',
		level: 'surface',
		multiply: 18.9 * 0.025,
		...AVERAGE_OR_INSTANT
	}
};

/** Pressure-level fields: `<prefix>_<level>hPa` is `<name>:<level> mb`. */
const PRESSURE_LEVEL_FIELDS: Record<string, Pick<GfsGribVariable, 'name' | 'add' | 'multiply'>> = {
	temperature: { name: 'TMP', ...KELVIN },
	wind_u_component: { name: 'UGRD' },
	wind_v_component: { name: 'VGRD' },
	geopotential_height: { name: 'HGT' },
	cloud_cover: { name: 'TCDC' },
	relative_humidity: { name: 'RH' },
	// Geometric vertical velocity in m/s, as the API serves it
	vertical_velocity: { name: 'DZDT' }
};

const PRESSURE_LEVEL_VARIABLE = /^(?<prefix>[a-z_]+?)_(?<level>\d+)hPa$/;

/** The GRIB record an Open-Meteo variable is read from, or undefined for one GFS has no record for. */
export const gfsGribVariable = (variable: string): GfsGribVariable | undefined => {
	const surface = GFS_SURFACE_VARIABLES[variable];
	if (surface) return surface;
	const groups = variable.match(PRESSURE_LEVEL_VARIABLE)?.groups;
	if (!groups) return undefined;
	const field = PRESSURE_LEVEL_FIELDS[groups.prefix];
	return field && { ...field, level: `${groups.level} mb` };
};

const PRESSURE_LEVEL_PREFIX = Object.fromEntries(
	Object.entries(PRESSURE_LEVEL_FIELDS).map(([prefix, field]) => [field.name, prefix])
);

/**
 * The Open-Meteo variable names an index has records for: what `stored` is
 * for the derivation rules, so wind speed is derived from the components the
 * way it is from an `.om` file storing them.
 */
export const gfsStoredVariables = (records: GribIndexRecord[]): Set<string> => {
	const present = new Set(records.map((record) => `${record.name}:${record.level}`));
	const stored = new Set<string>();
	for (const [variable, spec] of Object.entries(GFS_SURFACE_VARIABLES)) {
		if (present.has(`${spec.name}:${spec.level}`)) stored.add(variable);
	}
	for (const record of records) {
		const prefix = PRESSURE_LEVEL_PREFIX[record.name];
		const level = record.level.match(/^(\d+) mb$/)?.[1];
		if (prefix && level) stored.add(`${prefix}_${level}hPa`);
	}
	return stored;
};

/**
 * Index files holding further records of the same time step: the 0.25°
 * `pgrb2b` file carries the pressure levels left out of `pgrb2`. Consulted
 * only for a variable the primary index lacks, so a read of a common field
 * costs one index fetch.
 */
export const gfsCompanionIndexUrls = (indexUrl: string): string[] =>
	/\.pgrb2\.0p25\.f\d{3}\.idx$/.test(indexUrl)
		? [indexUrl.replace('.pgrb2.0p25.', '.pgrb2b.0p25.')]
		: [];
