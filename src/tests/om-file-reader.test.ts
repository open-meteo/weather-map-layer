/**
 * Reads through the derivation rules of a `WeatherMapLayerFileReader`, against
 * an in-memory stand-in for the `.om` file: the backend pool hands out a root
 * reader whose children are the entries of `file`.
 */
import {
	WeatherMapLayerFileReader,
	defaultDerivationRules,
	variableHasDirections,
	variableSupportsBarbs
} from '../om-file-reader';
import type { VariableDerivationRule } from '../om-file-reader';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The variables of the fake file; each test fills it before reading. */
const { file } = vi.hoisted(() => ({ file: new Map<string, FakeVariable>() }));

/** Child reader of one variable, recording what the file reader did with it. */
class FakeVariable {
	disposed = false;
	prefetched = false;

	constructor(
		private readonly values: number[],
		private readonly factor: number
	) {}

	getDimensions(): number[] {
		return [1, this.values.length];
	}

	scaleFactor(): number {
		return this.factor;
	}

	async read(): Promise<Float32Array> {
		return new Float32Array(this.values);
	}

	async readPrefetch(): Promise<void> {
		this.prefetched = true;
	}

	dispose(): void {
		this.disposed = true;
	}
}

vi.mock('@openmeteo/file-reader', async () => {
	const actual = await vi.importActual('@openmeteo/file-reader');
	return {
		...actual,
		OmHttpBackendPool: class {
			withReader<T>(_url: string, _cache: unknown, fn: (reader: unknown) => T): T {
				return fn({ getChildByName: async (name: string) => file.get(name) ?? null });
			}
			clear(): void {}
		}
	};
});

// Snowfall in cm from the snowfall water equivalent in mm, the conversion the
// Open-Meteo API applies: 1 mm of water melts from 0.7 cm of snow.
const snowfallRule: VariableDerivationRule = {
	pattern: /^snowfall$/,
	provides: { directions: false, barbs: false },
	// The water equivalent is stored in 0.1 mm steps, so snowfall lands on a
	// 0.07 cm grid.
	scaleFactor: 1 / 0.07,
	getSourceVars: () => ['snowfall_water_equivalent'],
	process: ([waterEquivalent]) => ({
		values: waterEquivalent.map((mm) => mm * 0.7),
		directions: undefined
	})
};
const rules = [snowfallRule, ...defaultDerivationRules];

const createReader = (derivationRules?: VariableDerivationRule[]) =>
	new WeatherMapLayerFileReader({ useSAB: false, derivationRules });

beforeEach(() => file.clear());

describe('custom derivation rules', () => {
	it('derives a variable from a single source', async () => {
		const waterEquivalent = new FakeVariable([0, 1, 10], 10);
		file.set('snowfall_water_equivalent', waterEquivalent);

		const data = await createReader(rules).readVariable('file.om', 'snowfall');

		expect(Array.from(data.values ?? [])).toEqual([0, expect.closeTo(0.7), expect.closeTo(7)]);
		expect(data.directions).toBeUndefined();
		expect(data.scaleFactor).toBe(1 / 0.07);
		expect(waterEquivalent.disposed).toBe(true);
	});

	it('reads the source variable itself without the rule', async () => {
		file.set('snowfall_water_equivalent', new FakeVariable([0, 1, 10], 10));

		const data = await createReader(rules).readVariable('file.om', 'snowfall_water_equivalent');

		expect(Array.from(data.values ?? [])).toEqual([0, 1, 10]);
		expect(data.scaleFactor).toBe(10);
	});

	it('keeps the defaults deriving when they are spread behind a custom rule', async () => {
		file.set('wind_u_component_10m', new FakeVariable([3], 10));
		file.set('wind_v_component_10m', new FakeVariable([4], 10));

		const data = await createReader(rules).readVariable('file.om', 'wind_u_component_10m');

		expect(data.values?.[0]).toBeCloseTo(5);
		expect(data.directions?.[0]).toBeCloseTo(216.87, 1);
		// `'primary'`: the stored factor of the first source, the u-component
		expect(data.scaleFactor).toBe(10);
		expect(variableHasDirections('wind_u_component_10m', rules)).toBe(true);
		expect(variableSupportsBarbs('wind_speed_10m', rules)).toBe(true);
		expect(variableHasDirections('snowfall', rules)).toBe(false);
	});

	it('replaces the defaults: without them a wind component is a plain variable', async () => {
		file.set('wind_u_component_10m', new FakeVariable([3], 10));
		file.set('wind_v_component_10m', new FakeVariable([4], 10));

		const data = await createReader([snowfallRule]).readVariable('file.om', 'wind_u_component_10m');

		expect(Array.from(data.values ?? [])).toEqual([3]);
		expect(data.directions).toBeUndefined();
		expect(variableHasDirections('wind_u_component_10m', [snowfallRule])).toBe(false);
	});

	it('fails on a missing source variable and still disposes the others', async () => {
		const u = new FakeVariable([3], 10);
		file.set('wind_u_component_10m', u);

		await expect(createReader().readVariable('file.om', 'wind_u_component_10m')).rejects.toThrow(
			'Source variable wind_v_component_10m not found'
		);
		expect(u.disposed).toBe(true);
	});

	it('rejects a rule that names no source variables', async () => {
		const noSources: VariableDerivationRule = { ...snowfallRule, getSourceVars: () => [] };

		await expect(createReader([noSources]).readVariable('file.om', 'snowfall')).rejects.toThrow(
			'no source variables'
		);
	});

	it('prefetches every source variable of a derived one', async () => {
		const u = new FakeVariable([3], 10);
		const v = new FakeVariable([4], 10);
		file.set('wind_u_component_10m', u);
		file.set('wind_v_component_10m', v);

		await createReader().prefetchVariable('file.om', 'wind_v_component_10m');

		expect(u.prefetched && v.prefetched).toBe(true);
		expect(u.disposed && v.disposed).toBe(true);
	});
});
