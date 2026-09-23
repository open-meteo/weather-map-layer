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
	getStateValues,
	clearBackends,
	getRanges,
	getProtocolInstance
} from './om-protocol-state';
export { updateCurrentBounds } from './utils/bounds';
export { createClippingTester } from './utils/clipping';
export { domainStep, closestModelRun } from './utils/model-runs';
export { variableHasDirections, variableSupportsBarbs } from './om-file-reader';
export { getCachedResolvedClipping } from './utils/parse-request';
export { getColor, getColorScale } from './utils/styling';
export { solarPosition, sunElevationSine } from './utils/sun';

// Classes

export { GridFactory } from './grids/index';
// The block caches for `fileReaderConfig.cache`. Re-exported because the file
// reader is bundled into this module: importing them from
// `@openmeteo/file-reader` directly would give a consumer a second copy of it.
export { BrowserBlockCache, LruBlockCache } from '@openmeteo/file-reader';

// Objects / Constants

export { currentBounds } from './utils/bounds';
export { defaultOmProtocolSettings } from './om-protocol';
export { domainOptions, domainGroups } from './domains';
export { getDomainBoundary } from './domain-footprints';
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

// GPU custom layer (experimental, see src/gpu/README.md)

export {
	WeatherGpuLayer,
	isGpuSupported,
	loadOmUrl,
	WeatherGpuRenderer,
	computeGridUniforms
} from './gpu/index';
export type {
	WeatherGpuLayerOptions,
	LoadedOmData,
	GpuAdvectionSource,
	GpuArrowConfig,
	GpuArrowLevel,
	GpuParticleConfig,
	ArrowSampler,
	GpuContourStyle
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

export type { VariableDerivationRule } from './om-file-reader';
// A value export, not type-only as on main: the GPU prefetch path constructs
// its own reader instances rather than going through the protocol state.
export { WeatherMapLayerFileReader } from './om-file-reader';
export type { BlockCache } from '@openmeteo/file-reader';
