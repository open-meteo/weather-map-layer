export { omProtocol } from './om-protocol';

// Types

export type {
	AnyDomain,
	ClippingOptions,
	Data,
	Domain,
	DomainMetaDataJson,
	GeoJson,
	GeoJsonFeature,
	GeoJsonGeometry,
	GeoJsonPosition,
	OmProtocolSettings,
	OmUrlState,
	RenderableColorScale,
	SeamlessDomain,
	SeamlessLayer
} from './types';

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
