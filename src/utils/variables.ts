const pressureLevels = [
	10, 15, 20, 30, 40, 50, 70, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300, 325, 350, 375, 400,
	425, 450, 475, 500, 525, 550, 575, 600, 625, 650, 675, 700, 725, 750, 775, 800, 825, 850, 875,
	900, 925, 950, 970, 975, 985, 1000, 1015
];

const heights = [
	2, 10, 20, 30, 40, 50, 75, 80, 100, 120, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800,
	1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000, 3250, 3500, 3750, 4000, 4500, 5000, 5500,
	6000
];

export const variableOptions = [
	{ value: 'albedo', label: 'Albedo' },

	{ value: 'boundary_layer_height', label: 'Boundary Layer Height' },

	{ value: 'cape', label: 'CAPE' },

	{ value: 'categorical_freezing_rain', label: 'Categorical Freezing Rain' },

	{ value: 'cloud_base', label: 'Cloud Base' },
	{ value: 'cloud_cover', label: 'Cloud Cover' },
	{ value: 'cloud_cover_2m', label: 'Cloud Cover (2m)' },
	{ value: 'cloud_cover_anomaly', label: 'Cloud Cover Anomaly' },
	{ value: 'cloud_cover_high', label: 'Cloud Cover High' },
	{ value: 'cloud_cover_low', label: 'Cloud Cover Low' },
	{ value: 'cloud_cover_mean', label: 'Cloud Cover Mean' },
	{ value: 'cloud_cover_mid', label: 'Cloud Cover Mid' },
	{ value: 'cloud_top', label: 'Cloud Top' },

	{ value: 'convective_cloud_base', label: 'Convective Cloud Base' },
	{ value: 'convective_cloud_top', label: 'Convective Cloud Top' },
	{ value: 'convective_inhibition', label: 'Convective Inhibition' },

	{ value: 'dew_point_2m', label: 'Dew Point (2m)' },
	{ value: 'dew_point_2m_anomaly', label: 'Dew Point (2m) Anomaly' },
	{ value: 'dew_point_2m_mean', label: 'Dew Point (2m) Mean' },

	{ value: 'diffuse_radiation', label: 'Diffuse Radiation' },
	{ value: 'direct_radiation', label: 'Direct Radiation' },

	{ value: 'freezing_level_height', label: 'Freezing Level Height' },
	{ value: 'freezing_rain_probability', label: 'Freezing Rain Probability' },

	{ value: 'ice_pellets_probability', label: 'Ice Pellets Probability' },

	{ value: 'k_index', label: 'k Index' },

	{ value: 'latent_heat_flux', label: 'Latent Heat Flux' },

	{ value: 'lifted_index', label: 'Lifted Index' },
	{ value: 'lightning_potential', label: 'Lightning Potential' },

	{ value: 'mass_density_8m', label: 'Mass Density (8m)' },

	{ value: 'potential_evapotranspiration', label: 'Potential Evapotranspiration' },

	{ value: 'precipitation', label: 'Precipitation' },
	{ value: 'precipitation_anomaly', label: 'Precipitation Anomaly' },
	{ value: 'precipitation_anomaly_gt0', label: 'Precipitation Anomaly GT0' },
	{ value: 'precipitation_anomaly_gt10', label: 'Precipitation Anomaly GT10' },
	{ value: 'precipitation_anomaly_gt20', label: 'Precipitation EFI' },
	{ value: 'precipitation_efi', label: 'Precipitation Probability' },
	{ value: 'precipitation_mean', label: 'Precipitation Mean' },
	{ value: 'precipitation_probability', label: 'Precipitation Probability' },
	{ value: 'precipitation_sot90', label: 'Precipitation SOT90' },
	{ value: 'precipitation_type', label: 'Precipitation Type' },

	{ value: 'pressure_msl', label: 'Pressure Mean Sea Level' },
	{ value: 'pressure_msl_anomaly', label: 'Pressure Mean Sea Level Anomaly' },
	{ value: 'pressure_msl_anomaly_gt0', label: 'Pressure Mean Sea Level Anomaly GT0' },
	{ value: 'pressure_msl_mean', label: 'Pressure Mean Sea Level Mean' },

	{ value: 'rain', label: 'Rain' },
	{ value: 'rain_probability', label: 'Rain Probability' },

	{ value: 'runoff', label: 'Runoff' },

	{ value: 'roughness_length', label: 'Roughness Length' },

	{ value: 'sea_surface_temperature_anomaly', label: 'Sea Surface Temperature Anomaly' },
	{ value: 'sea_surface_temperature_mean', label: 'Sea Surface Temperature Mean' },

	{ value: 'sensible_heat_flux', label: 'Sensible Heat Flux' },

	{ value: 'secondary_swell_wave_height', label: 'Secondary Swell Wave Height & Direction' },
	{ value: 'secondary_swell_wave_period', label: 'Secondary Swell Wave Period' },
	{ value: 'secondary_swell_wave_direction', label: 'Secondary Swell Wave Direction' },

	{ value: 'showers', label: 'Showers' },
	{ value: 'showers_mean', label: 'Showers Mean' },

	{ value: 'shortwave_radiation', label: 'Shortwave Solar Radiation' },

	{ value: 'snow', label: 'Snow' },
	{ value: 'snow_depth', label: 'Snow Depth' },
	{ value: 'snow_depth_water_equivalent', label: 'Snow Depth Water Equivalent' },
	{ value: 'snow_depth_water_equivalent_anomaly', label: 'Snow Depth Water Equivalent Anomaly' },
	{ value: 'snow_depth_water_equivalent_mean', label: 'Snow Depth Water Equivalent Mean' },
	{ value: 'snow_density', label: 'Snow Density' },
	{ value: 'snow_density_anomaly', label: 'Snow Density Anomaly' },
	{ value: 'snow_density_mean', label: 'Snow Density Mean' },

	{ value: 'snowfall', label: 'Snowfall' },
	{ value: 'snowfall_probability', label: 'Snowfall Probability' },
	{ value: 'snowfall_height', label: 'Snowfall Height' },
	{ value: 'snowfall_water_equivalent', label: 'Snowfall Water Equivalent' },
	{ value: 'snowfall_water_equivalent_anomaly', label: 'Snowfall Water Equivalent Anomaly' },
	{ value: 'snowfall_water_equivalent_mean', label: 'Snowfall Water Equivalent Mean' },

	{ value: 'sunshine_duration', label: 'Sunshine Duration' },
	{ value: 'sunshine_duration_anomaly', label: 'Sunshine Duration Anomaly' },
	{ value: 'sunshine_duration_mean', label: 'Sunshine Duration Mean' },

	{ value: 'surface_temperature', label: 'Surface Temperature' },
	{ value: 'surface_temperature_anomaly_gt0', label: 'Surface Temperature Anomaly GT0' },

	{ value: 'swell_wave_height', label: 'Swell Wave Height' },
	{ value: 'swell_wave_peak_period', label: 'Swell Wave Peak Period' },
	{ value: 'swell_wave_period', label: 'Swell Wave Period' },

	{ value: 'temperature_2m_anomaly', label: 'Temperature (2m) Anomaly' },
	{ value: 'temperature_2m_anomaly_gt0', label: 'Temperature (2m) Anomaly GT0' },
	{ value: 'temperature_2m_anomaly_gt1', label: 'Temperature (2m) Anomaly GT1' },
	{ value: 'temperature_2m_anomaly_gt2', label: 'Temperature (2m) Anomaly GT2' },
	{ value: 'temperature_2m_anomaly_ltm0', label: 'Temperature (2m) Anomaly LTM0' },
	{ value: 'temperature_2m_anomaly_ltm1', label: 'Temperature (2m) Anomaly LTM1' },
	{ value: 'temperature_2m_anomaly_ltm2', label: 'Temperature (2m) Anomaly LTM2' },
	{ value: 'temperature_2m_efi', label: 'Temperature (2m) EFI' },
	{ value: 'temperature_2m_mean', label: 'Temperature (2m) Mean' },
	{ value: 'temperature_2m_sot10', label: 'Temperature (2m) SOT10' },
	{ value: 'temperature_2m_sot90', label: 'Temperature (2m) SOT90' },
	{ value: 'temperature_max6h_2m_anomaly', label: 'Temperature Max 6h (2m) Anomaly' },
	{ value: 'temperature_max6h_2m_mean', label: 'Temperature Max 6h (2m) Mean' },
	{ value: 'temperature_min6h_2m_anomaly', label: 'Temperature Min 6h (2m) Anomaly' },
	{ value: 'temperature_min6h_2m_mean', label: 'Temperature Min 6h (2m) Mean' },

	{ value: 'tertiary_swell_wave_height', label: 'Tertiary Swell Wave Height & Direction' },
	{ value: 'tertiary_swell_wave_period', label: 'Tertiary Swell Wave Period' },

	{ value: 'thunderstorm_probability', label: 'Thunderstorm Probability' },

	{ value: 'total_column_integrated_water_vapour', label: 'Total Column Integrated Water Vapour' },
	{
		value: 'total_column_integrated_water_vapour_anomaly',
		label: 'Total Column Integrated Water Vapour Anomaly'
	},
	{
		value: 'total_column_integrated_water_vapour_mean',
		label: 'Total Column Integrated Water Vapour Mean'
	},

	{ value: 'uv_index', label: 'UV Index' },
	{ value: 'uv_index_clear_sky', label: 'UV Index Clear Sky' },

	{ value: 'visibility', label: 'Visibility' },

	{ value: 'wave_height', label: 'Wave Height & Direction' },
	{ value: 'wave_period', label: 'Wave Period' },
	{ value: 'wave_direction', label: 'Wave Direction' },
	{ value: 'wave_peak_period', label: 'Wave Peak Period' },

	{ value: 'weather_code', label: 'Weather Codes' },

	{ value: 'wind_gusts_10m', label: 'Wind Gusts (10m)' },

	{ value: 'wind_wave_height', label: 'Wind Wave Height' },
	{ value: 'wind_wave_period', label: 'Wind Wave Period' },
	{ value: 'wind_wave_peak_period', label: 'Wind Wave Peak Period' },
	{ value: 'wind_u_component_10m_anomaly', label: 'Wind (10m) Anomaly' },
	{ value: 'wind_u_component_10m_mean', label: 'Wind (10m) Mean' },
	{ value: 'wind_u_component_100m_anomaly', label: 'Wind (100m) Anomaly' },
	{ value: 'wind_u_component_100m_mean', label: 'Wind (100m) Mean' },

	{ value: 'updraft', label: 'Updraft' },

	{ value: 'soil_temperature_0cm', label: 'Soil Temperature (0 cm)' },
	{ value: 'soil_temperature_6cm', label: 'Soil Temperature (6 cm)' },
	{ value: 'soil_temperature_18cm', label: 'Soil Temperature (18 cm)' },
	{ value: 'soil_temperature_54cm', label: 'Soil Temperature (54 cm)' },
	{ value: 'soil_temperature_162cm', label: 'Soil Temperature (162 cm)' },
	{ value: 'soil_temperature_468cm', label: 'Soil Temperature (486 cm)' },
	{ value: 'soil_temperature_1458cm', label: 'Soil Temperature (1458 cm)' },

	{ value: 'soil_temperature_0_to_7cm', label: 'Soil Temperature (0-7 cm)' },
	{ value: 'soil_temperature_0_to_10cm', label: 'Soil Temperature (0-10 cm)' },
	{ value: 'soil_temperature_7_to_28cm', label: 'Soil Temperature (7-28 cm)' },
	{ value: 'soil_temperature_10_to_40cm', label: 'Soil Temperature (10-40 cm)' },
	{ value: 'soil_temperature_40_to_100cm', label: 'Soil Temperature (40-100 cm)' },
	{ value: 'soil_temperature_100_to_200cm', label: 'Soil Temperature (100-200 cm)' },

	{ value: 'soil_moisture_0_to_1cm', label: 'Soil Moisture (0-1 cm)' },
	{ value: 'soil_moisture_0_to_7cm', label: 'Soil Moisture (0-7 cm)' },
	{ value: 'soil_moisture_1_to_3cm', label: 'Soil Moisture (1-3 cm)' },
	{ value: 'soil_moisture_3_to_9cm', label: 'Soil Moisture (3-9 cm)' },
	{ value: 'soil_moisture_0_to_10cm', label: 'Soil Moisture (0-10 cm)' },
	{ value: 'soil_moisture_7_to_28cm', label: 'Soil Moisture (7-28 cm)' },
	{ value: 'soil_moisture_9_to_27cm', label: 'Soil Moisture (9-27 cm)' },
	{ value: 'soil_moisture_10_to_40cm', label: 'Soil Moisture (10-40 cm)' },
	{ value: 'soil_moisture_27_to_81cm', label: 'Soil Moisture (27-81 cm)' },
	{ value: 'soil_moisture_40_to_100cm', label: 'Soil Moisture (40-100 cm)' },
	{ value: 'soil_moisture_100_to_200cm', label: 'Soil Moisture (100-200 cm)' },

	// level groups
	{ value: 'geopotential_height', label: 'Geopotential Height' },
	{ value: 'relative_humidity', label: 'Relative Humidity' },
	{ value: 'soil_moisture', label: 'Soil Moisture' },
	{ value: 'soil_temperature', label: 'Soil Temperature' },
	{ value: 'temperature', label: 'Temperature' },
	{ value: 'vertical_velocity', label: 'Vertical Velocity' },
	{ value: 'wind', label: 'Wind' }
];

export const levelGroupVariables = [
	'cloud_cover',
	'geopotential_height',
	'relative_humidity',
	'soil_moisture',
	'soil_temperature',
	'temperature',
	'vertical_velocity',
	'wind'
];

for (const pl of pressureLevels) {
	variableOptions.push({ value: `cloud_cover_${pl}hPa`, label: `Cloud Cover (${pl}hPa)` });
	variableOptions.push({
		value: `geopotential_height_${pl}hPa`,
		label: `Geopotential Height (${pl}hPa)`
	});
	variableOptions.push({
		value: `relative_humidity_${pl}hPa`,
		label: `Relative Humidity (${pl}hPa)`
	});
	variableOptions.push({ value: `temperature_${pl}hPa`, label: `Temperature (${pl}hPa)` });
	variableOptions.push({
		value: `vertical_velocity_${pl}hPa`,
		label: `Vertical Velocity (${pl}hPa)`
	});
	variableOptions.push({ value: `wind_${pl}hPa`, label: `Wind (${pl}hPa)` });
	variableOptions.push({ value: `wind_u_component_${pl}hPa`, label: `Wind (${pl}hPa)` });
	variableOptions.push({ value: `wind_speed_${pl}hPa`, label: `Wind (${pl}hPa)` });
}
for (const height of heights) {
	variableOptions.push({
		value: `relative_humidity_${height}m`,
		label: `Relative Humidity (${height}m)`
	});
	variableOptions.push({ value: `temperature_${height}m`, label: `Temperature (${height}m)` });
	variableOptions.push({ value: `wind_${height}m`, label: `Wind (${height}m)` });
	variableOptions.push({ value: `wind_u_component_${height}m`, label: `Wind (${height}m)` });
	variableOptions.push({ value: `wind_speed_${height}m`, label: `Wind (${height}m)` });
}

export const drawOnTiles = ['pressure_msl'];
