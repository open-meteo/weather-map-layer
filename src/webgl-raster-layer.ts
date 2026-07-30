import type {
	CustomLayerInterface,
	CustomRenderMethodInput,
	Map as MapLibreMap
} from 'maplibre-gl';

import { colorScaleRange, createColorRampBytes, resolveWebGLColorScale } from './webgl/color-ramp';
import type { LegacyWebGLColorStop, WebGLColorScale } from './webgl/color-ramp';
import { WebGLWeatherDataSource } from './webgl/data-source';
import {
	createProgram,
	createRampTexture,
	requireWebGL2,
	textureSizeSupported
} from './webgl/gl-utils';
import {
	gridTransformShader,
	latitudeToMercatorY,
	longitudeToMercatorX,
	visibleWorldOffsets
} from './webgl/grid-transform';

import type { Domain, RenderableColorScale } from './types';

export interface WebGLRasterLayerOptions {
	colorScale?: WebGLColorScale;
	opacity?: number;
	colorBlend?: boolean;
	darkMode?: boolean;
	onLoad?: () => void;
	onError?: (error: Error) => void;
}

export type WebGLLayerStatus = 'idle' | 'loading' | 'ready' | 'error' | 'removed';

const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);

const fieldSamplingShader = (
	nx: number,
	ny: number,
	longitudeWrap: boolean,
	manualLinear: boolean
): string => {
	const wrapX = longitudeWrap
		? `x = mod(mod(x, ${nx.toFixed(1)}) + ${nx.toFixed(1)}, ${nx.toFixed(1)});`
		: `x = clamp(x, 0.0, ${(nx - 1).toFixed(1)});`;
	if (!manualLinear) {
		return `
			float sampleField(vec2 grid) {
				vec2 uv = (grid + 0.5) / vec2(${nx.toFixed(1)}, ${ny.toFixed(1)});
				return texture2D(u_data_texture, uv).r;
			}
		`;
	}
	return `
		float finiteValue(float value) {
			return value == value && abs(value) < 3.402823e38 ? 1.0 : 0.0;
		}
		float fieldTexel(float x, float y) {
			${wrapX}
			y = clamp(y, 0.0, ${(ny - 1).toFixed(1)});
			return texture2D(
				u_data_texture,
				(vec2(x, y) + 0.5) / vec2(${nx.toFixed(1)}, ${ny.toFixed(1)})
			).r;
		}
		float sampleField(vec2 grid) {
			vec2 lower = floor(grid);
			vec2 fraction = fract(grid);
			float v00 = fieldTexel(lower.x, lower.y);
			float v10 = fieldTexel(lower.x + 1.0, lower.y);
			float v01 = fieldTexel(lower.x, lower.y + 1.0);
			float v11 = fieldTexel(lower.x + 1.0, lower.y + 1.0);
			float w00 = (1.0 - fraction.x) * (1.0 - fraction.y) * finiteValue(v00);
			float w10 = fraction.x * (1.0 - fraction.y) * finiteValue(v10);
			float w01 = (1.0 - fraction.x) * fraction.y * finiteValue(v01);
			float w11 = fraction.x * fraction.y * finiteValue(v11);
			float weight = w00 + w10 + w01 + w11;
			if (weight == 0.0) return 3.402823e38;
			v00 = finiteValue(v00) > 0.5 ? v00 : 0.0;
			v10 = finiteValue(v10) > 0.5 ? v10 : 0.0;
			v01 = finiteValue(v01) > 0.5 ? v01 : 0.0;
			v11 = finiteValue(v11) > 0.5 ? v11 : 0.0;
			return (v00 * w00 + v10 * w10 + v01 * w01 + v11 * w11) / weight;
		}
	`;
};

export class WebGLRasterLayer implements CustomLayerInterface {
	id: string;
	type = 'custom' as const;
	renderingMode = '2d' as const;

	/** @deprecated Prefer the repository's variable-specific color scales. */
	static readonly temperatureColorScale: LegacyWebGLColorStop[] = [
		{ value: -35, color: [75, 0, 130, 255] },
		{ value: -30, color: [128, 0, 128, 255] },
		{ value: -20, color: [75, 0, 130, 255] },
		{ value: -15, color: [0, 0, 255, 255] },
		{ value: -10, color: [0, 128, 255, 255] },
		{ value: -5, color: [0, 255, 255, 255] },
		{ value: 0, color: [0, 255, 128, 255] },
		{ value: 5, color: [64, 255, 128, 255] },
		{ value: 10, color: [0, 255, 0, 255] },
		{ value: 15, color: [128, 255, 0, 255] },
		{ value: 20, color: [192, 255, 0, 255] },
		{ value: 25, color: [255, 255, 0, 255] },
		{ value: 30, color: [255, 192, 0, 255] },
		{ value: 35, color: [255, 128, 0, 255] },
		{ value: 40, color: [255, 64, 0, 255] },
		{ value: 45, color: [255, 0, 0, 255] },
		{ value: 50, color: [200, 0, 0, 255] },
		{ value: 55, color: [128, 0, 0, 255] },
		{ value: 60, color: [75, 0, 0, 255] }
	];

	/** @deprecated Prefer the repository's variable-specific color scales. */
	static readonly windSpeedColorScale: LegacyWebGLColorStop[] = [
		{ value: 0, color: [0, 0, 255, 255] },
		{ value: 5, color: [0, 255, 255, 255] },
		{ value: 10, color: [0, 255, 0, 255] },
		{ value: 15, color: [255, 255, 0, 255] },
		{ value: 20, color: [255, 128, 0, 255] },
		{ value: 25, color: [255, 0, 0, 255] },
		{ value: 30, color: [128, 0, 0, 255] }
	];

	private readonly source: WebGLWeatherDataSource;
	private readonly ownsSource: boolean;
	private readonly variable: string;
	private options: Required<Pick<WebGLRasterLayerOptions, 'opacity' | 'colorBlend' | 'darkMode'>> &
		Omit<WebGLRasterLayerOptions, 'opacity' | 'colorBlend' | 'darkMode'>;
	private colorScale: WebGLColorScale;
	private map?: MapLibreMap;
	private gl?: WebGL2RenderingContext;
	private program?: WebGLProgram;
	private buffer?: WebGLBuffer;
	private vertexArray?: WebGLVertexArrayObject;
	private dataTexture?: WebGLTexture;
	private rampTexture?: WebGLTexture;
	private matrixLocation?: WebGLUniformLocation;
	private boundsLocation?: WebGLUniformLocation;
	private rangeLocation?: WebGLUniformLocation;
	private opacityLocation?: WebGLUniformLocation;
	private statusValue: WebGLLayerStatus = 'idle';
	private abortController?: AbortController;
	private projectionErrorReported = false;
	private readonly handleContextLost = (): void => {
		if (this.statusValue === 'removed') return;
		this.statusValue = 'loading';
		this.program = undefined;
		this.buffer = undefined;
		this.vertexArray = undefined;
		this.dataTexture = undefined;
		this.rampTexture = undefined;
	};
	private readonly handleContextRestored = (): void => {
		if (!this.gl || this.statusValue === 'removed') return;
		this.abortController = new AbortController();
		this.initialize(this.gl, this.abortController.signal).catch((error: unknown) =>
			this.reportError(error)
		);
	};

	constructor(
		id: string,
		source: WebGLWeatherDataSource,
		variable: string,
		options?: WebGLRasterLayerOptions
	);
	constructor(
		id: string,
		omUrl: string,
		domain: Domain,
		variable: string,
		colorScale?: LegacyWebGLColorStop[],
		options?: WebGLRasterLayerOptions
	);
	constructor(
		id: string,
		sourceOrUrl: WebGLWeatherDataSource | string,
		domainOrVariable: Domain | string,
		variableOrOptions?: string | WebGLRasterLayerOptions,
		legacyColorScale?: LegacyWebGLColorStop[],
		legacyOptions?: WebGLRasterLayerOptions
	) {
		this.id = id;
		if (sourceOrUrl instanceof WebGLWeatherDataSource) {
			this.source = sourceOrUrl;
			this.ownsSource = false;
			this.variable = domainOrVariable as string;
			this.options = this.resolveOptions(variableOrOptions as WebGLRasterLayerOptions | undefined);
		} else {
			this.source = new WebGLWeatherDataSource(sourceOrUrl, domainOrVariable as Domain);
			this.ownsSource = true;
			this.variable = variableOrOptions as string;
			this.options = this.resolveOptions({
				...legacyOptions,
				colorScale: legacyColorScale ?? legacyOptions?.colorScale
			});
		}
		this.colorScale = resolveWebGLColorScale(
			this.variable,
			this.options.colorScale,
			this.options.darkMode
		);
	}

	get status(): WebGLLayerStatus {
		return this.statusValue;
	}

	setOptions(options: Partial<WebGLRasterLayerOptions>): void {
		this.options = this.resolveOptions({ ...this.options, ...options });
		this.colorScale = resolveWebGLColorScale(
			this.variable,
			this.options.colorScale,
			this.options.darkMode
		);
		if (this.gl) {
			if (this.rampTexture) this.gl.deleteTexture(this.rampTexture);
			this.rampTexture = createRampTexture(
				this.gl,
				createColorRampBytes(this.colorScale, this.options.colorBlend)
			);
		}
		this.map?.triggerRepaint();
	}

	onAdd(map: MapLibreMap, context: WebGLRenderingContext | WebGL2RenderingContext): void {
		this.map = map;
		map.on('webglcontextlost', this.handleContextLost);
		map.on('webglcontextrestored', this.handleContextRestored);
		this.statusValue = 'loading';
		this.abortController = new AbortController();
		this.initialize(context, this.abortController.signal).catch((error: unknown) => {
			if (
				this.statusValue === 'removed' ||
				(error instanceof DOMException && error.name === 'AbortError')
			) {
				return;
			}
			this.reportError(error);
		});
	}

	render(
		gl: WebGLRenderingContext | WebGL2RenderingContext,
		options: CustomRenderMethodInput
	): void {
		if (
			this.statusValue !== 'ready' ||
			!this.program ||
			!this.buffer ||
			!this.dataTexture ||
			!this.rampTexture ||
			!this.map
		) {
			return;
		}
		if ((this.map.getProjection()?.type ?? 'mercator') !== 'mercator') {
			if (!this.projectionErrorReported) {
				this.projectionErrorReported = true;
				const error = new Error(
					'WebGL weather layers currently support MapLibre Mercator projection only.'
				);
				if (this.options.onError) this.options.onError(error);
				else console.error(`[WebGLRasterLayer:${this.id}]`, error);
			}
			return;
		}
		this.projectionErrorReported = false;

		gl.useProgram(this.program);
		(gl as WebGL2RenderingContext).bindVertexArray(this.vertexArray!);
		gl.uniformMatrix4fv(this.matrixLocation!, false, options.defaultProjectionData.mainMatrix);

		const [minimum, maximum] = colorScaleRange(this.colorScale);
		gl.uniform2f(this.rangeLocation!, minimum, maximum);
		gl.uniform1f(this.opacityLocation!, this.options.opacity);

		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
		gl.uniform1i(gl.getUniformLocation(this.program, 'u_data_texture'), 0);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
		gl.uniform1i(gl.getUniformLocation(this.program, 'u_color_ramp'), 1);

		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

		const descriptor = this.source.grid;
		const bounds = this.map.getBounds();
		for (const offset of visibleWorldOffsets(
			descriptor.bounds,
			bounds.getWest(),
			bounds.getEast()
		)) {
			gl.uniform4f(
				this.boundsLocation!,
				longitudeToMercatorX(descriptor.bounds[0] + offset),
				latitudeToMercatorY(descriptor.bounds[3]),
				longitudeToMercatorX(descriptor.bounds[2] + offset),
				latitudeToMercatorY(descriptor.bounds[1])
			);
			gl.drawArrays(gl.TRIANGLES, 0, 6);
		}
		(gl as WebGL2RenderingContext).bindVertexArray(null);
	}

	onRemove(_map: MapLibreMap, context: WebGLRenderingContext | WebGL2RenderingContext): void {
		this.statusValue = 'removed';
		this.abortController?.abort();
		this.map?.off('webglcontextlost', this.handleContextLost);
		this.map?.off('webglcontextrestored', this.handleContextRestored);
		if (this.program) context.deleteProgram(this.program);
		if (this.buffer) context.deleteBuffer(this.buffer);
		if (this.vertexArray) (context as WebGL2RenderingContext).deleteVertexArray(this.vertexArray);
		if (this.dataTexture) context.deleteTexture(this.dataTexture);
		if (this.rampTexture) context.deleteTexture(this.rampTexture);
		if (this.ownsSource) this.source.dispose();
		this.map = undefined;
		this.gl = undefined;
	}

	private resolveOptions(options: WebGLRasterLayerOptions = {}) {
		return {
			...options,
			opacity: Math.max(0, Math.min(1, options.opacity ?? 0.75)),
			colorBlend: options.colorBlend ?? true,
			darkMode: options.darkMode ?? false
		};
	}

	private async initialize(
		context: WebGLRenderingContext | WebGL2RenderingContext,
		signal: AbortSignal
	): Promise<void> {
		const gl = requireWebGL2(context);
		this.gl = gl;
		const descriptor = this.source.grid;
		if (!textureSizeSupported(gl, descriptor.nx, descriptor.ny)) {
			throw new Error(
				`Weather texture ${descriptor.nx}×${descriptor.ny} exceeds this device's MAX_TEXTURE_SIZE (${gl.getParameter(
					gl.MAX_TEXTURE_SIZE
				)}).`
			);
		}

		const floatLinear = Boolean(gl.getExtension('OES_texture_float_linear'));
		const vertexSource = `
			attribute vec2 a_position;
			uniform mat4 u_matrix;
			uniform vec4 u_mercator_bounds;
			varying vec2 v_mercator;
			void main() {
				v_mercator = mix(u_mercator_bounds.xy, u_mercator_bounds.zw, a_position);
				gl_Position = u_matrix * vec4(v_mercator, 0.0, 1.0);
			}
		`;
		const fragmentSource = `
			precision highp float;
			uniform sampler2D u_data_texture;
			uniform sampler2D u_color_ramp;
			uniform vec2 u_value_range;
			uniform float u_opacity;
			varying vec2 v_mercator;
			${gridTransformShader(descriptor)}
			${fieldSamplingShader(descriptor.nx, descriptor.ny, descriptor.longitudeWrap, !floatLinear)}
			float mercatorYToLatitude(float y) {
				return degrees(2.0 * atan(exp((0.5 - y) * 2.0 * 3.141592653589793)) - 1.5707963267948966);
			}
			void main() {
				vec2 lonLat = vec2((v_mercator.x - 0.5) * 360.0, mercatorYToLatitude(v_mercator.y));
				vec2 grid = geographicToGrid(lonLat);
				if (grid.x < -0.5 || grid.x > ${descriptor.nx - 0.5} ||
					grid.y < -0.5 || grid.y > ${descriptor.ny - 0.5}) discard;
				float value = sampleField(grid);
				if (value != value || abs(value) >= 3.402823e38) discard;
				float normalized = clamp(
					(value - u_value_range.x) / max(0.000001, u_value_range.y - u_value_range.x),
					0.0,
					1.0
				);
				vec4 color = texture2D(u_color_ramp, vec2(normalized, 0.5));
				color.a *= u_opacity;
				color.rgb *= color.a;
				gl_FragColor = color;
			}
		`;
		this.program = createProgram(gl, vertexSource, fragmentSource);
		this.matrixLocation = gl.getUniformLocation(this.program, 'u_matrix')!;
		this.boundsLocation = gl.getUniformLocation(this.program, 'u_mercator_bounds')!;
		this.rangeLocation = gl.getUniformLocation(this.program, 'u_value_range')!;
		this.opacityLocation = gl.getUniformLocation(this.program, 'u_opacity')!;

		this.buffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
		this.vertexArray = gl.createVertexArray()!;
		gl.bindVertexArray(this.vertexArray);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		const position = gl.getAttribLocation(this.program, 'a_position');
		gl.enableVertexAttribArray(position);
		gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);

		const data = await this.source.loadVariable(this.variable, signal);
		if (signal.aborted || this.statusValue === 'removed') return;
		this.dataTexture = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
		gl.texParameteri(
			gl.TEXTURE_2D,
			gl.TEXTURE_WRAP_S,
			descriptor.longitudeWrap ? gl.REPEAT : gl.CLAMP_TO_EDGE
		);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, floatLinear ? gl.LINEAR : gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, floatLinear ? gl.LINEAR : gl.NEAREST);
		gl.texImage2D(
			gl.TEXTURE_2D,
			0,
			gl.R32F,
			descriptor.nx,
			descriptor.ny,
			0,
			gl.RED,
			gl.FLOAT,
			data.values!
		);
		if (gl.getError() !== gl.NO_ERROR)
			throw new Error('Failed to upload the weather data texture.');

		this.rampTexture = createRampTexture(
			gl,
			createColorRampBytes(this.colorScale, this.options.colorBlend)
		);
		this.statusValue = 'ready';
		this.options.onLoad?.();
		this.map?.triggerRepaint();
	}

	private reportError(error: unknown): void {
		const resolved = error instanceof Error ? error : new Error(String(error));
		this.statusValue = 'error';
		if (this.options.onError) this.options.onError(resolved);
		else console.error(`[WebGLRasterLayer:${this.id}]`, resolved);
	}
}

export type { LegacyWebGLColorStop, RenderableColorScale, WebGLColorScale };
