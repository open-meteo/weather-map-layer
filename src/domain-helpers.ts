/**
 * Helpers for `AnyDomain` values: telling seamless composites apart from
 * concrete grid domains, resolving a composite to the concrete domains behind
 * it, and deciding which of its layers take part in a request.
 */
import { boundsIntersect } from './utils/bounds';

import { GridFactory } from './grids/index';

import type { AnyDomain, Bounds, Domain, SeamlessDomain, SeamlessLayer } from './types';

export const isSeamlessDomain = (domain: AnyDomain): domain is SeamlessDomain =>
	'type' in domain && domain.type === 'seamless';

/**
 * The concrete `Domain` whose `value` is `domainValue`; undefined when it is
 * missing from `domainOptions` or names a composite.
 */
export const resolveConcreteDomain = (
	domainValue: string,
	domainOptions: AnyDomain[]
): Domain | undefined =>
	domainOptions.find((d): d is Domain => d.value === domainValue && !isSeamlessDomain(d));

/** The global layer of a composite: the last one, which covers the whole world. */
export const getGlobalLayer = (domain: SeamlessDomain): SeamlessLayer =>
	domain.layers[domain.layers.length - 1];

/**
 * The `value` of the concrete domain that stands in for `domain` wherever a
 * single server path or grid is needed (metadata, TileJSON bounds, initial map
 * position): a composite's global layer, or the domain itself.
 */
export const getConcreteDomainValue = (domain: AnyDomain): string =>
	isSeamlessDomain(domain) ? getGlobalLayer(domain).domainValue : domain.value;

/**
 * `getConcreteDomainValue` resolved to the `Domain` itself; undefined when a
 * composite's global domain is not in `domainOptions`.
 */
export const getConcreteDomain = (
	domain: AnyDomain,
	domainOptions: AnyDomain[]
): Domain | undefined =>
	isSeamlessDomain(domain)
		? resolveConcreteDomain(getGlobalLayer(domain).domainValue, domainOptions)
		: domain;

export interface SeamlessLayerFilter {
	/** Map zoom: layers whose `minZoom` lies above it are left out. */
	zoom?: number;
	/** Viewport: regional layers that do not overlap it are left out (the global layer always stays). */
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
	domainOptions: AnyDomain[],
	{ zoom, viewportBounds, leadTimeHours }: SeamlessLayerFilter = {}
): ActiveSeamlessLayer[] => {
	const globalLayer = getGlobalLayer(seamless);
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
		if (layer !== globalLayer && viewportBounds) {
			const domainBounds = GridFactory.create(domain.grid, null).getBounds() as Bounds;
			if (!boundsIntersect(domainBounds, viewportBounds)) continue;
		}
		active.push({ layer, domain });
	}
	return active;
};
