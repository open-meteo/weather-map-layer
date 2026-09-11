import { WeatherMapLayerFileReader } from '../om-file-reader';
import type { FileReaderConfig } from '../om-file-reader';

import { WebGLGridDescriptor, createWebGLGridDescriptor } from './grid-transform';

import type { Data, Domain } from '../types';

export interface WebGLWindData extends Data {
	values: Float32Array;
	directions: Float32Array;
	u: Float32Array;
	v: Float32Array;
}

const abortable = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
	if (!signal) return promise;
	if (signal.aborted)
		return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
		signal.addEventListener('abort', abort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener('abort', abort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener('abort', abort);
				reject(error);
			}
		);
	});
};

export class WebGLWeatherDataSource {
	readonly url: string;
	readonly domain: Domain;
	readonly grid: WebGLGridDescriptor;

	private readonly reader: WeatherMapLayerFileReader;
	private readerReady?: Promise<void>;
	private readonly variables = new Map<string, Promise<Data>>();
	private readonly windVariables = new Map<string, Promise<WebGLWindData>>();
	private disposed = false;

	constructor(url: string, domain: Domain, config: FileReaderConfig = {}) {
		this.url = url;
		this.domain = domain;
		this.grid = createWebGLGridDescriptor(domain.grid);
		this.reader = new WeatherMapLayerFileReader(config);
	}

	loadVariable(variable: string, signal?: AbortSignal): Promise<Data> {
		if (this.disposed) {
			return Promise.reject(new Error('The WebGL weather data source has been disposed.'));
		}
		let request = this.variables.get(variable);
		if (!request) {
			this.readerReady ??= this.reader.setToOmFile(this.url);
			request = this.readerReady
				.then(() =>
					this.reader.readVariable(variable, [
						{ start: 0, end: this.grid.ny },
						{ start: 0, end: this.grid.nx }
					])
				)
				.then((data) => {
					if (!data.values) throw new Error(`Variable "${variable}" did not contain values.`);
					const expected = this.grid.nx * this.grid.ny;
					if (data.values.length !== expected) {
						throw new Error(
							`Variable "${variable}" has ${data.values.length} values, but domain "${this.domain.value}" requires ${expected} (${this.grid.nx}×${this.grid.ny}).`
						);
					}
					if (data.directions && data.directions.length !== expected) {
						throw new Error(
							`Variable "${variable}" has ${data.directions.length} directions, but ${expected} were expected.`
						);
					}
					return data;
				});
			this.variables.set(variable, request);
			request.catch(() => this.variables.delete(variable));
		}
		return abortable(request, signal);
	}

	loadWindVariable(variable: string, signal?: AbortSignal): Promise<WebGLWindData> {
		if (this.disposed) {
			return Promise.reject(new Error('The WebGL weather data source has been disposed.'));
		}
		let request = this.windVariables.get(variable);
		if (!request) {
			request = this.loadVariable(variable).then((data) => {
				if (!data.values || !data.directions) {
					throw new Error(
						`Variable "${variable}" does not provide wind direction. Use a u/v component or speed/direction variable pair.`
					);
				}
				const u = new Float32Array(data.values.length);
				const v = new Float32Array(data.values.length);
				for (let index = 0; index < data.values.length; index++) {
					const angle = ((data.directions[index] + 180) * Math.PI) / 180;
					u[index] = data.values[index] * Math.sin(angle);
					v[index] = data.values[index] * Math.cos(angle);
				}
				return { ...data, values: data.values, directions: data.directions, u, v };
			});
			this.windVariables.set(variable, request);
			request.catch(() => this.windVariables.delete(variable));
		}
		return abortable(request, signal);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.variables.clear();
		this.windVariables.clear();
		this.reader.dispose();
	}
}
