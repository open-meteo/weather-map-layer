export { omProtocol } from './om-protocol';
export type { OmDataState } from './om-protocol-state';

// Functions

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

// Classes

export { GridFactory } from './grids/index';

// Objects / Constants

export { currentBounds } from './utils/bounds';
export { defaultOmProtocolSettings } from './om-protocol';
export { domainOptions, domainGroups } from './domains';
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

// Adapters

export { addLeafletProtocolSupport } from './adapters/leaflet';
export { addMapboxProtocolSupport } from './adapters/mapbox';
export { addOpenLayersProtocolSupport } from './adapters/openlayers';

// Types

export type {
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
	RenderableColorScale
} from './types';

export type { WeatherMapLayerFileReader } from './om-file-reader';
