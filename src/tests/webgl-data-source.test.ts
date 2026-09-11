import { WeatherMapLayerFileReader } from '../om-file-reader';
import { WebGLWeatherDataSource } from '../webgl/data-source';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Domain } from '../types';

const domain: Domain = {
	value: 'synthetic',
	label: 'Synthetic',
	grid: {
		type: 'regular',
		nx: 3,
		ny: 2,
		lonMin: 0,
		latMin: 0,
		dx: 1,
		dy: 1
	},
	time_interval: 'hourly',
	model_interval: 'hourly'
};

afterEach(() => vi.restoreAllMocks());

describe('WebGLWeatherDataSource', () => {
	test('coalesces concurrent variable reads', async () => {
		vi.spyOn(WeatherMapLayerFileReader.prototype, 'setToOmFile').mockResolvedValue();
		const read = vi.spyOn(WeatherMapLayerFileReader.prototype, 'readVariable').mockResolvedValue({
			values: new Float32Array([1, 2, 3, 4, 5, 6]),
			directions: undefined
		});
		const source = new WebGLWeatherDataSource('https://example.test/weather.om', domain);

		const [first, second] = await Promise.all([
			source.loadVariable('temperature_2m'),
			source.loadVariable('temperature_2m')
		]);

		expect(read).toHaveBeenCalledTimes(1);
		expect(first).toBe(second);
		source.dispose();
	});

	test('rejects data whose dimensions do not match the domain', async () => {
		vi.spyOn(WeatherMapLayerFileReader.prototype, 'setToOmFile').mockResolvedValue();
		vi.spyOn(WeatherMapLayerFileReader.prototype, 'readVariable').mockResolvedValue({
			values: new Float32Array([1, 2, 3]),
			directions: undefined
		});
		const source = new WebGLWeatherDataSource('https://example.test/weather.om', domain);

		await expect(source.loadVariable('temperature_2m')).rejects.toThrow(/requires 6 \(3×2\)/);
		source.dispose();
	});

	test('prepares wind components once without circular direction interpolation', async () => {
		vi.spyOn(WeatherMapLayerFileReader.prototype, 'setToOmFile').mockResolvedValue();
		const read = vi.spyOn(WeatherMapLayerFileReader.prototype, 'readVariable').mockResolvedValue({
			values: new Float32Array([10, 10, 10, 10, 10, 10]),
			directions: new Float32Array([359, 1, 90, 180, 270, 0])
		});
		const source = new WebGLWeatherDataSource('https://example.test/weather.om', domain);

		const [first, second] = await Promise.all([
			source.loadWindVariable('wind_u_component_10m'),
			source.loadWindVariable('wind_u_component_10m')
		]);

		expect(read).toHaveBeenCalledTimes(1);
		expect(first).toBe(second);
		expect(first.u[0]).toBeCloseTo(-first.u[1], 5);
		expect(first.v[0]).toBeCloseTo(first.v[1], 5);
		source.dispose();
	});

	test('caller abort does not cancel the shared underlying read', async () => {
		vi.spyOn(WeatherMapLayerFileReader.prototype, 'setToOmFile').mockResolvedValue();
		let resolveRead: ((value: { values: Float32Array; directions: undefined }) => void) | undefined;
		vi.spyOn(WeatherMapLayerFileReader.prototype, 'readVariable').mockReturnValue(
			new Promise((resolve) => {
				resolveRead = resolve;
			})
		);
		const source = new WebGLWeatherDataSource('https://example.test/weather.om', domain);
		const controller = new AbortController();
		const abandoned = source.loadVariable('temperature_2m', controller.signal);
		const retained = source.loadVariable('temperature_2m');
		controller.abort();
		resolveRead!({
			values: new Float32Array([1, 2, 3, 4, 5, 6]),
			directions: undefined
		});

		await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
		await expect(retained).resolves.toMatchObject({ values: expect.any(Float32Array) });
		source.dispose();
	});
});
