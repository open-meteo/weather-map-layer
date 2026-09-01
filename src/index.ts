export { omProtocol } from './om-protocol';
export type { OmDataState } from './om-protocol-state';
export {
	sunProtocol,
	DEFAULT_SUN_SHADOW_OPACITY,
	DEFAULT_SUN_SHADOW_GRADIENT,
	DEFAULT_SUN_SHADOW_COLOR
} from './sun-protocol';

// Functions

export {
	isSeamlessDomain,
	getFallbackDomainValue,
	resolveConcreteDomain,
	getFallbackDomain
} from './domain-helpers';
export {
	getValueFromLatLong,
	clearBlockCache,
	getDataState,
	clearBackends,
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
export { WeatherMapLayerFileReader } from './om-file-reader';

// Objects / Constants

export { currentBounds } from './utils/bounds';
export { defaultOmProtocolSettings } from './om-protocol';
export { domainOptions, domainGroups } from './domains';
export { DOMAIN_FOOTPRINTS, getDomainFootprint } from './domain-footprints';
export { variableOptions, levelGroupVariables } from './utils/variables';
export {
	VARIABLE_PREFIX,
	LEVEL_PREFIX,
	LEVEL_REGEX,
	LEVEL_UNIT_REGEX,
	VALID_ARROW_STYLES,
	DEFAULT_ARROW_STYLE,
	VALID_ARROW_RENDERS,
	DEFAULT_ARROW_RENDER,
	TILE_PX,
	ARROW_LATTICE,
	BARB_LATTICE
} from './utils/constants';

// GPU render paths (experimental, see src/gpu/README.md)

export {
	WeatherGpuLayer,
	omProtocolGpu,
	GpuTileRenderer,
	getSharedTileRenderer,
	isGpuSupported,
	loadOmUrl,
	WeatherGpuRenderer,
	computeGridUniforms,
	mercatorBoxMatrix
} from './gpu/index';
export type {
	WeatherGpuLayerOptions,
	LoadedOmData,
	GpuArrowConfig,
	GpuArrowLevel,
	ArrowSampler
} from './gpu/index';
// Exposed for the GPU parity verification (scripts/verify-gpu.mjs): the exact
// CPU blend the seamless raster/vector paths use.
export { sampleBlendedValue } from './utils/seamless-sampling';

// Adapters

export { addLeafletProtocolSupport } from './adapters/leaflet';
export { addMapboxProtocolSupport } from './adapters/mapbox';
export { addOpenLayersProtocolSupport } from './adapters/openlayers';

// Types

export type {
	AnyDomain,
	ArrowRender,
	ArrowStyle,
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
	SeamlessDomain,
	SeamlessLayer,
	SunShadowOptions
} from './types';
