export { omProtocol } from './om-protocol';
export {
	sunProtocol,
	DEFAULT_SUN_SHADOW_OPACITY,
	DEFAULT_SUN_SHADOW_GRADIENT,
	DEFAULT_SUN_SHADOW_COLOR
} from './sun-protocol';

// Functions

export {
	getValueFromLatLong,
	clearBlockCache,
	getRanges,
	getProtocolInstance
} from './om-protocol-state';
export { updateCurrentBounds } from './utils/bounds';
export { createClippingTester } from './utils/clipping';
export { domainStep, closestModelRun } from './utils/model-runs';
export { getCachedResolvedClipping } from './utils/parse-request';
export { getColor, getColorScale } from './utils/styling';
export { solarPosition, sunElevationSine } from './utils/sun';

// Classes

export { GridFactory } from './grids/index';

// Objects / Constants

export { currentBounds } from './utils/bounds';
export { defaultOmProtocolSettings } from './om-protocol';
export { domainOptions, domainGroups } from './domains';
export { variableOptions, levelGroupVariables } from './utils/variables';
export { VARIABLE_PREFIX, LEVEL_PREFIX, LEVEL_REGEX, LEVEL_UNIT_REGEX } from './utils/constants';

// Adapters

export { addLeafletProtocolSupport } from './adapters/leaflet';
export { addMapboxProtocolSupport } from './adapters/mapbox';
export { addOpenLayersProtocolSupport } from './adapters/openlayers';

// Types

export type {
	ClippingOptions,
	Data,
	Domain,
	DomainMetaDataJson,
	GeoJson,
	GeoJsonFeature,
	GeoJsonGeometry,
	GeoJsonPosition,
	InterpolationMethod,
	OmProtocolSettings,
	OmUrlState,
	RenderableColorScale,
	SunShadowOptions
} from './types';

export type { WeatherMapLayerFileReader } from './om-file-reader';
