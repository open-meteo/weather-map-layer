/**
 * Helpers for `Domain` values: telling seamless composites apart from
 * concrete grid domains, resolving a composite to the concrete domains behind
 * it, and deciding which of its layers take part in a request.
 */
import { boundsIntersect } from './utils/bounds';

import { GridFactory } from './grids/index';

import type { Bounds, Domain, SeamlessDomain, SeamlessLayer } from './types';

export const isSeamlessDomain = (domain: Domain): domain is SeamlessDomain =>
	'type' in domain && domain.type === 'seamless';

/**
 * The concrete `Domain` whose `value` is `domainValue`; undefined when it is
 * missing from `domainOptions` or names a composite.
 */
export const resolveConcreteDomain = (
	domainValue: string,
	domainOptions: Domain[]
): Domain | undefined => domainOptions.find((d) => d.value === domainValue && !isSeamlessDomain(d));

/**
 * The base layer of a composite: the last one, coarsest, with `minZoom: 0`. It
 * covers the composite's whole extent (global or regional), so it always takes
 * part in a request.
 */
export const getBaseLayer = (domain: SeamlessDomain): SeamlessLayer =>
	domain.layers[domain.layers.length - 1];

/**
 * The `value` of the concrete domain that stands in for `domain` wherever a
 * single server path is needed (metadata, initial map position): a composite's
 * base layer, or the domain itself.
 */
export const getConcreteDomainValue = (domain: Domain): string =>
	isSeamlessDomain(domain) ? getBaseLayer(domain).domainValue : domain.value;

export interface SeamlessLayerFilter {
	/** Map zoom: layers whose `minZoom` lies above it are left out. */
	zoom?: number;
	/** Viewport: finer layers that do not overlap it are left out (the base layer always stays). */
	viewportBounds?: Bounds;
	/** Lead time of the requested timestep: layers past their `maxForecastHours` are left out. */
	leadTimeHours?: number;
}

export interface ActiveSeamlessLayer {
	layer: SeamlessLayer;
	domain: Domain;
}

/**
 * The layers of a composite that take part in a request, finest-first, each
 * with its concrete domain. This is the one place that decides which
 * sub-domains are active: the protocol loads exactly these, and consumers
 * (prefetching, border overlays) call it to stay in step. Layers whose domain
 * is not in `domainOptions` are skipped with a warning.
 */
export const selectSeamlessLayers = (
	seamless: SeamlessDomain,
	domainOptions: Domain[],
	{ zoom, viewportBounds, leadTimeHours }: SeamlessLayerFilter = {}
): ActiveSeamlessLayer[] => {
	const baseLayer = getBaseLayer(seamless);
	const active: ActiveSeamlessLayer[] = [];
	for (const layer of seamless.layers) {
		if (zoom !== undefined && layer.minZoom > zoom) continue;
		if (
			leadTimeHours !== undefined &&
			layer.maxForecastHours !== undefined &&
			leadTimeHours > layer.maxForecastHours
		) {
			continue;
		}
		const domain = resolveConcreteDomain(layer.domainValue, domainOptions);
		if (!domain) {
			console.warn(`[seamless] Domain not found: ${layer.domainValue}`);
			continue;
		}
		if (layer !== baseLayer && viewportBounds) {
			const domainBounds = GridFactory.create(domain.grid, null).getBounds() as Bounds;
			if (!boundsIntersect(domainBounds, viewportBounds)) continue;
		}
		active.push({ layer, domain });
	}
	return active;
};
