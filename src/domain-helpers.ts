/**
 * Helpers for working with `AnyDomain` values — in particular for resolving the
 * concrete grid-based `Domain` that backs a zoom-adaptive `SeamlessDomain`.
 *
 * These were previously re-implemented inline in several consumers (and inside
 * this library); they are collected here and exported so both the protocol
 * internals and downstream apps share a single source of truth.
 */
import type { AnyDomain, Domain, SeamlessDomain } from './types';

/** Returns true when `domain` is a `SeamlessDomain` (composite, zoom-adaptive). */
export const isSeamlessDomain = (domain: AnyDomain): domain is SeamlessDomain => 'layers' in domain;

/**
 * Returns the `value` of the concrete domain that should back `domain`:
 *  - for a `SeamlessDomain`, the last layer's `domainValue` (the global fallback);
 *  - for a regular `Domain`, its own `value`.
 *
 * Useful when a seamless domain needs to be mapped to a real server path or grid,
 * e.g. for metadata fetches and initial map positioning.
 */
export const getFallbackDomainValue = (domain: AnyDomain): string =>
	isSeamlessDomain(domain) ? domain.layers[domain.layers.length - 1].domainValue : domain.value;

/**
 * Looks up the concrete (non-seamless) `Domain` whose `value` matches `domainValue`.
 * Returns `undefined` when no matching concrete domain exists.
 */
export const resolveConcreteDomain = (
	domainValue: string,
	domainOptions: AnyDomain[]
): Domain | undefined =>
	domainOptions.find((d) => d.value === domainValue && !isSeamlessDomain(d)) as Domain | undefined;

/**
 * Resolves the concrete `Domain` that backs `domain`:
 *  - for a `SeamlessDomain`, the concrete domain of its global fallback layer;
 *  - for a regular `Domain`, the domain itself.
 *
 * Returns `undefined` when a seamless domain's backing domain is not present in
 * `domainOptions`.
 */
export const getFallbackDomain = (
	domain: AnyDomain,
	domainOptions: AnyDomain[]
): Domain | undefined =>
	isSeamlessDomain(domain)
		? resolveConcreteDomain(getFallbackDomainValue(domain), domainOptions)
		: domain;
