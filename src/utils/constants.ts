export const DEFAULT_INTERVAL = 2;

export const VALID_TILE_SIZES = [64, 128, 256, 512, 1024, 2048];
export const DEFAULT_TILE_SIZE = 512;

export const VALID_INTERPOLATIONS = ['nearest', 'linear', 'cubic', 'monotone'] as const;
export const DEFAULT_INTERPOLATION = 'linear';

// Interpolate colours between colour-scale breakpoints instead of hard bands.
export const DEFAULT_COLOR_BLEND = false;
export const VECTOR_TILE_EXTENT = 4096;

// Parameters affecting data identity
export const DATA_RELEVANT_PARAMS = new Set(['variable']);

/* OM URL */
export const OM_PREFIX_REGEX = /^om:\/\/([^?]+)(?:\?(.*))?$/;

export const TILE_SUFFIX_REGEX = /(?:\/)(\d+)(?:\/)(\d+)(?:\/)(\d+)$/i;

export const TIME_SELECTED_REGEX = /([0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}00)/;

/* Variables */
// The domain is the path segment before the ".om" file, independent of any
// "data_spatial/" prefix (CDN pull zones drop it). An optional model-run path
// "YYYY/MM/DD/HHMMZ/" may sit between the domain and the file, so it is skipped:
//   <domain>/file.om                         -> <domain>
//   <domain>/YYYY/MM/DD/HHMMZ/<time>.om      -> <domain>
export const RESOLVE_DOMAIN_REGEX =
	/(?<domain>[^/]+)\/(?:\d{4}\/\d{2}\/\d{2}\/\d{4}Z\/)?[^/]+\.om$/;

export const DOMAIN_META_REGEX =
	/(http|https):\/\/(?<uri>[\s\S]+)\/(?<domain>[\s\S]+)\/(?<meta>[\s\S]+).json/;

export const TIME_STEP_REGEX =
	/(?<capture>(current_time|valid_times))(_)?(?<modifier>(\+|-))?(?<amountAndUnit>.*)?/;

export const VARIABLE_PREFIX =
	/(?<prefix>(cloud_cover|dew_point|geopotential_height|precipitation|relative_humidity|snow|soil_moisture|soil_temperature|swell|temperature|vertical_velocity|wind(?!_gusts|_direction)))_/;

/* Pressure / Height Levels */
export const LEVEL_REGEX =
	/((?<height_level_to>\d+_to_.*)|(?<pressure_level>\d+hPa)|(?<height_level>\d+(m|cm)))(?!_)/;

export const LEVEL_PREFIX =
	/(?<prefix>(cloud_cover|geopotential_height|relative_humidity|soil_moisture|soil_temperature|temperature|vertical_velocity|wind(?!_gusts|_direction)))_/;

export const LEVEL_UNIT_REGEX = /_(?<level>\d+)(?<unit>(m|cm|hPa))/;
