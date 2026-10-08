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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
				return fn({
					getChildByName: async (name: string) => file.get(name) ?? null,
					numberOfChildren: () => file.size,
					// Listing children only needs their names; a throwaway child per
					// entry, like the real reader hands out
					getChild: async (index: number) => ({
						getName: () => [...file.keys()][index],
						dispose: () => {}
					})
				});
			}
			clear(): void {}
		}
	};
});

// Snowfall with a 10:1 snow-to-liquid ratio instead of the API's fixed 0.7
// used by the default rule; listed first, it takes `snowfall` over.
const snowfallRule: VariableDerivationRule = {
	pattern: /^snowfall$/,
	provides: { directions: false, barbs: false },
	scaleFactor: 'primary',
	getSourceVars: ({ variable, stored }) =>
		!stored.has(variable) && stored.has('snowfall_water_equivalent')
			? ['snowfall_water_equivalent']
			: null,
	process: ([waterEquivalent]) => ({
		values: waterEquivalent.map((mm) => mm * 1),
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

		expect(Array.from(data.values ?? [])).toEqual([0, 1, 10]);
		expect(data.directions).toBeUndefined();
		expect(data.scaleFactor).toBe(10);
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

	it('falls through to the next matching rule, then to the stored variable', async () => {
		file.set('snowfall', new FakeVariable([7], 10));
		file.set('snowfall_water_equivalent', new FakeVariable([10], 10));
		const reader = createReader(rules);

		// Both the custom and the default rule pass for a file storing snowfall
		const stored = await reader.readVariable('file.om', 'snowfall');
		expect(Array.from(stored.values ?? [])).toEqual([7]);

		file.delete('snowfall');
		file.delete('snowfall_water_equivalent');
		await expect(reader.readVariable('file.om', 'snowfall')).rejects.toThrow(
			'Variable: snowfall not found'
		);
	});

	it('fails on a source variable a rule names without checking, and still disposes the others', async () => {
		const unchecked: VariableDerivationRule = {
			...snowfallRule,
			getSourceVars: () => ['snowfall_water_equivalent', 'temperature_2m']
		};
		const waterEquivalent = new FakeVariable([3], 10);
		file.set('snowfall_water_equivalent', waterEquivalent);

		await expect(createReader([unchecked]).readVariable('file.om', 'snowfall')).rejects.toThrow(
			'Source variable temperature_2m not found'
		);
		expect(waterEquivalent.disposed).toBe(true);
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

describe('default rules following what the file stores', () => {
	it('reads a lone wind component as stored when its sibling is missing', async () => {
		file.set('wind_u_component_10m', new FakeVariable([3], 10));

		const data = await createReader().readVariable('file.om', 'wind_u_component_10m');

		expect(Array.from(data.values ?? [])).toEqual([3]);
		expect(data.directions).toBeUndefined();
	});

	it('derives wind speed and direction from components where no speed is stored', async () => {
		file.set('wind_u_component_10m', new FakeVariable([3], 10));
		file.set('wind_v_component_10m', new FakeVariable([4], 10));
		const reader = createReader();

		const speed = await reader.readVariable('file.om', 'wind_speed_10m');
		expect(speed.values?.[0]).toBeCloseTo(5);
		expect(speed.directions?.[0]).toBeCloseTo(216.87, 1);

		const direction = await reader.readVariable('file.om', 'wind_direction_10m');
		expect(direction.values?.[0]).toBeCloseTo(5);
		expect(direction.directions?.[0]).toBeCloseTo(216.87, 1);
	});

	it('pairs a stored wind speed with its direction', async () => {
		file.set('wind_speed_10m', new FakeVariable([5], 10));
		file.set('wind_direction_10m', new FakeVariable([90], 1));
		file.set('wind_u_component_10m', new FakeVariable([3], 10));
		file.set('wind_v_component_10m', new FakeVariable([4], 10));

		const data = await createReader().readVariable('file.om', 'wind_direction_10m');

		expect(Array.from(data.values ?? [])).toEqual([5]);
		expect(Array.from(data.directions ?? [])).toEqual([90]);
	});

	it('derives snowfall and rain where they are not stored, subtracting showers only where stored', async () => {
		file.set('precipitation', new FakeVariable([5, 1], 10));
		file.set('snowfall_water_equivalent', new FakeVariable([1, 2], 10));
		const reader = createReader();

		const snowfall = await reader.readVariable('file.om', 'snowfall');
		expect(Array.from(snowfall.values ?? [])).toEqual([expect.closeTo(0.7), expect.closeTo(1.4)]);

		// Rain never drops below zero
		const rain = await reader.readVariable('file.om', 'rain');
		expect(Array.from(rain.values ?? [])).toEqual([4, 0]);

		file.set('showers', new FakeVariable([1.5, NaN], 10));
		const withShowers = await reader.readVariable('file.om', 'rain');
		expect(Array.from(withShowers.values ?? [])).toEqual([2.5, 0]);
	});

	it('derives dew point, relative humidity and radiation from their counterparts', async () => {
		file.set('temperature_2m', new FakeVariable([25], 20));
		file.set('relative_humidity_2m', new FakeVariable([60], 1));
		file.set('shortwave_radiation', new FakeVariable([500], 1));
		file.set('direct_radiation', new FakeVariable([600], 1));
		const reader = createReader();

		const dewPoint = await reader.readVariable('file.om', 'dew_point_2m');
		expect(dewPoint.values?.[0]).toBeCloseTo(16.698, 2);
		expect(dewPoint.scaleFactor).toBe(20);

		// Clamped at zero, like the API
		const diffuse = await reader.readVariable('file.om', 'diffuse_radiation');
		expect(Array.from(diffuse.values ?? [])).toEqual([0]);

		file.delete('relative_humidity_2m');
		file.set('dew_point_2m', new FakeVariable([16.698], 20));
		const humidity = await reader.readVariable('file.om', 'relative_humidity_2m');
		expect(humidity.values?.[0]).toBeCloseTo(60, 1);
		expect(humidity.scaleFactor).toBe(1);
	});

	it('takes the dew point for the humidity-derived fields where no relative humidity is stored', async () => {
		file.set('temperature_2m', new FakeVariable([25], 20));
		file.set('dew_point_2m', new FakeVariable([16.698], 20));
		file.set('wind_speed_10m', new FakeVariable([5], 10));
		file.set('shortwave_radiation', new FakeVariable([0], 1));
		const reader = createReader();

		const deficit = await reader.readVariable('file.om', 'vapour_pressure_deficit');
		expect(deficit.values?.[0]).toBeCloseTo(1.267, 2);

		// Identical to the reading with u/v components of the same speed and
		// the radiation stored as its direct and diffuse parts
		const apparent = await reader.readVariable('file.om', 'apparent_temperature');
		file.delete('wind_speed_10m');
		file.delete('shortwave_radiation');
		file.set('wind_u_component_10m', new FakeVariable([3], 10));
		file.set('wind_v_component_10m', new FakeVariable([4], 10));
		file.set('direct_radiation', new FakeVariable([0], 1));
		file.set('diffuse_radiation', new FakeVariable([0], 1));
		const fromParts = await reader.readVariable('file.om', 'apparent_temperature');
		expect(apparent.values?.[0]).toBeCloseTo(fromParts.values?.[0] ?? NaN, 4);

		const shortwave = await reader.readVariable('file.om', 'shortwave_radiation');
		expect(Array.from(shortwave.values ?? [])).toEqual([0]);
	});
});

describe('humidity-derived default rules', () => {
	it('derives apparent temperature from five stored fields', async () => {
		file.set('temperature_2m', new FakeVariable([30, 0], 20));
		file.set('relative_humidity_2m', new FakeVariable([70, 50], 1));
		file.set('wind_u_component_10m', new FakeVariable([3, 6], 10));
		file.set('wind_v_component_10m', new FakeVariable([4, 8], 10));
		file.set('shortwave_radiation', new FakeVariable([800, 0], 1));

		const data = await createReader().readVariable('file.om', 'apparent_temperature');

		expect(data.values?.[0]).toBeCloseTo(34.699, 2);
		expect(data.values?.[1]).toBeCloseTo(-8.438, 2);
		expect(data.directions).toBeUndefined();
		// `'primary'`: the air temperature's stored factor
		expect(data.scaleFactor).toBe(20);
		expect(variableHasDirections('apparent_temperature')).toBe(false);
	});

	it('derives vapour pressure deficit and wet-bulb temperature from temperature and humidity', async () => {
		file.set('temperature_2m', new FakeVariable([25, 30], 20));
		file.set('relative_humidity_2m', new FakeVariable([60, 70], 1));
		const reader = createReader();

		const deficit = await reader.readVariable('file.om', 'vapour_pressure_deficit');
		expect(deficit.values?.[0]).toBeCloseTo(1.267, 2);
		expect(deficit.scaleFactor).toBe(100);

		const wetBulb = await reader.readVariable('file.om', 'wet_bulb_temperature_2m');
		expect(wetBulb.values?.[1]).toBeCloseTo(25.596, 2);
		expect(wetBulb.scaleFactor).toBe(20);
	});
});

describe('precipitation rate', () => {
	const runUrl = 'https://host/data_spatial/model/2026/10/08/0000Z';
	const meta = {
		completed: true,
		last_modified_time: '',
		reference_time: '2026-10-08T00:00Z',
		valid_times: [
			'2026-10-08T00:00Z',
			'2026-10-08T03:00Z',
			'2026-10-08T01:00Z',
			'2026-10-08T06:00Z'
		],
		variables: ['precipitation']
	};

	afterEach(() => vi.unstubAllGlobals());

	it('divides the stored sum by the time step from the run meta.json', async () => {
		const fetch = vi.fn(async () => Response.json(meta));
		vi.stubGlobal('fetch', fetch);
		file.set('precipitation', new FakeVariable([3, 0.6], 10));

		const data = await createReader().readVariable(
			`${runUrl}/2026-10-08T0600.om`,
			'precipitation_rate'
		);

		expect(Array.from(data.values ?? [])).toEqual([expect.closeTo(1), expect.closeTo(0.2)]);
		expect(data.scaleFactor).toBe(100);
		expect(fetch).toHaveBeenCalledWith(`${runUrl}/meta.json`);
	});

	it('fails for a file outside a model run, with the reason', async () => {
		vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
		file.set('precipitation', new FakeVariable([3], 10));

		await expect(createReader().readVariable('file.om', 'precipitation_rate')).rejects.toThrow(
			"precipitation_rate needs the model run's meta.json"
		);
		await expect(
			createReader().readVariable(`${runUrl}-missing/2026-10-08T0600.om`, 'precipitation_rate')
		).rejects.toThrow("needs the model run's meta.json");
	});

	it('passes when the sum itself is not stored', async () => {
		await expect(createReader().readVariable('file.om', 'rain_rate')).rejects.toThrow(
			'Variable: rain_rate not found'
		);
	});
});
