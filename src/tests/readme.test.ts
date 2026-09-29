/** Keeps the hand-written seamless table in the README in step with `domainOptions`. */
import { isSeamlessDomain } from '../domain-helpers';
import { domainOptions } from '../domains';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

/** The table rows, keyed by domain value, with the constituent-models cell. */
const rows = new Map(
	readme
		.split('\n')
		.filter((line) => /^\| `[a-z0-9_]+_seamless` /.test(line))
		.map((line) => {
			const [, value, layers] = line.split('|').map((cell) => cell.trim());
			return [value.replace(/`/g, ''), layers];
		})
);

describe('README seamless table', () => {
	it('lists exactly the composites of domainOptions, in order', () => {
		expect([...rows.keys()]).toEqual(domainOptions.filter(isSeamlessDomain).map((d) => d.value));
	});

	it("names each composite's layers finest-first with their zoom thresholds", () => {
		for (const composite of domainOptions.filter(isSeamlessDomain)) {
			const expected = composite.layers
				.map((layer, i, all) =>
					i < all.length - 1 ? `${layer.domainValue} (zoom ${layer.minZoom}+)` : layer.domainValue
				)
				.join(' → ');
			expect(rows.get(composite.value)).toBe(expected);
		}
	});
});
