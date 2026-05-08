export { omProtocol, defaultOmProtocolSettings } from './om-protocol';

export {
	getValueFromLatLong,
	clearBlockCache,
	getRanges,
	getProtocolInstance
} from './om-protocol-state';

export type {
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
	RenderableColorScale
} from './types';

export { domainOptions, domainGroups } from './domains';
export { variableOptions, levelGroupVariables } from './utils/variables';

export { GridFactory } from './grids/index';

export { currentBounds, updateCurrentBounds } from './utils/bounds';
export { createClippingTester } from './utils/clipping';
export { VARIABLE_PREFIX, LEVEL_PREFIX, LEVEL_REGEX, LEVEL_UNIT_REGEX } from './utils/constants';
export { domainStep, closestModelRun } from './utils/model-runs';
export { getCachedResolvedClipping } from './utils/parse-request';
export { getColor, getColorScale } from './utils/styling';

// Adapters
export { addLeafletProtocolSupport } from './adapters/leaflet';
export { addMapboxProtocolSupport } from './adapters/mapbox';
export { addOpenLayersProtocolSupport } from './adapters/openlayers';
