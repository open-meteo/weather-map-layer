export { omProtocol } from './om-protocol';

// Functions

export {
	getValueFromLatLong,
	clearBlockCache,
	clearBackends,
	getRanges,
	getProtocolInstance
} from './om-protocol-state';
export { updateCurrentBounds } from './utils/bounds';
export { createClippingTester } from './utils/clipping';
export { domainStep, closestModelRun } from './utils/model-runs';
export { variableHasDirections, variableSupportsBarbs } from './om-file-reader';
export { getCachedResolvedClipping } from './utils/parse-request';
export { wktToGridData } from './utils/wkt';
export { getColor, getColorScale } from './utils/styling';
export {
	registerLocalOmFile,
	unregisterLocalOmFile,
	getLocalOmFile,
	isLocalOmUrl
} from './local-files';

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
	TILE_PX,
	ARROW_LATTICE,
	BARB_LATTICE
} from './utils/constants';

// Adapters

export { addLeafletProtocolSupport } from './adapters/leaflet';
export { addMapboxProtocolSupport } from './adapters/mapbox';
export { addOpenLayersProtocolSupport } from './adapters/openlayers';

// Types

export type { LocalOmFile } from './local-files';
export type {
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
	RenderableColorScale
} from './types';

export type { VariableDerivationRule, WeatherMapLayerFileReader } from './om-file-reader';
export type { BlockCache } from '@openmeteo/file-reader';
