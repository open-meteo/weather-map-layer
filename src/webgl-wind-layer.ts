import type {
	CustomLayerInterface,
	CustomRenderMethodInput,
	Map as MapLibreMap
} from 'maplibre-gl';

import type { WebGLLayerStatus } from './webgl-raster-layer';
import { colorScaleRange, createColorRampBytes, resolveWebGLColorScale } from './webgl/color-ramp';
import type { WebGLColorScale } from './webgl/color-ramp';
import { WebGLWeatherDataSource } from './webgl/data-source';
import {
	createProgram,
	createRampTexture,
	requireWebGL2,
	textureSizeSupported
} from './webgl/gl-utils';
import { gridTransformShader } from './webgl/grid-transform';
import { computeParticleCount } from './webgl/wind-math';

import type { Domain } from './types';

export interface WebGLWindLayerOptions {
	simulationSpeed?: number;
	particleDensity?: number;
	minParticles?: number;
	maxParticles?: number;
	lineWidth?: number;
	trailHalfLife?: number;
	opacity?: number;
	colorScale?: WebGLColorScale;
	colorBlend?: boolean;
	darkMode?: boolean;
	onLoad?: () => void;
	onError?: (error: Error) => void;
}

type ResolvedWindOptions = Required<
	Pick<
		WebGLWindLayerOptions,
		| 'simulationSpeed'
		| 'particleDensity'
		| 'minParticles'
		| 'maxParticles'
		| 'lineWidth'
		| 'trailHalfLife'
		| 'opacity'
		| 'colorBlend'
		| 'darkMode'
	>
> &
	Omit<
		WebGLWindLayerOptions,
		| 'simulationSpeed'
		| 'particleDensity'
		| 'minParticles'
		| 'maxParticles'
		| 'lineWidth'
		| 'trailHalfLife'
		| 'opacity'
		| 'colorBlend'
		| 'darkMode'
	>;

const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
const MAX_REAL_FRAME_DELTA = 0.1;

const samplingShader = (
	nx: number,
	ny: number,
	longitudeWrap: boolean,
	manualLinear: boolean
): string => {
	if (!manualLinear) {
		return `
			float sampleField(sampler2D field, vec2 grid) {
				return texture(field, (grid + 0.5) / vec2(${nx}.0, ${ny}.0)).r;
			}
		`;
	}
	const wrap = longitudeWrap
		? `x = mod(mod(x, ${nx}.0) + ${nx}.0, ${nx}.0);`
		: `x = clamp(x, 0.0, ${nx - 1}.0);`;
	return `
		float fieldTexel(sampler2D field, float x, float y) {
			${wrap}
			y = clamp(y, 0.0, ${ny - 1}.0);
			return texture(field, (vec2(x, y) + 0.5) / vec2(${nx}.0, ${ny}.0)).r;
		}
		float sampleField(sampler2D field, vec2 grid) {
			vec2 lower = floor(grid);
			vec2 f = fract(grid);
			float a = fieldTexel(field, lower.x, lower.y);
			float b = fieldTexel(field, lower.x + 1.0, lower.y);
			float c = fieldTexel(field, lower.x, lower.y + 1.0);
			float d = fieldTexel(field, lower.x + 1.0, lower.y + 1.0);
			return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
		}
	`;
};

export class WebGLWindLayer implements CustomLayerInterface {
	id: string;
	type = 'custom' as const;
	renderingMode = '2d' as const;

	private readonly source: WebGLWeatherDataSource;
	private readonly ownsSource: boolean;
	private readonly variable: string;
	private options: ResolvedWindOptions;
	private colorScale: WebGLColorScale;
	private statusValue: WebGLLayerStatus = 'idle';
	private map?: MapLibreMap;
	private gl?: WebGL2RenderingContext;
	private abortController?: AbortController;
	private animationFrame?: number;
	private lastUpdateTime?: number;
	private cameraSignature?: string;
	private projectionErrorReported = false;

	private updateProgram?: WebGLProgram;
	private fadeProgram?: WebGLProgram;
	private segmentProgram?: WebGLProgram;
	private compositeProgram?: WebGLProgram;
	private quadBuffer?: WebGLBuffer;
	private quadVertexArray?: WebGLVertexArrayObject;
	private segmentVertexArray?: WebGLVertexArrayObject;
	private framebuffer?: WebGLFramebuffer;
	private speedTexture?: WebGLTexture;
	private windUTexture?: WebGLTexture;
	private windVTexture?: WebGLTexture;
	private colorRampTexture?: WebGLTexture;
	private particleTextures: WebGLTexture[] = [];
	private trailTextures: WebGLTexture[] = [];
	private particleTextureSize = 0;
	private particleCount = 0;
	private trailWidth = 0;
	private trailHeight = 0;
	private currentParticleTexture = 0;
	private currentTrailTexture = 0;
	private readonly handleContextLost = (): void => {
		if (this.statusValue === 'removed') return;
		if (this.animationFrame !== undefined) cancelAnimationFrame(this.animationFrame);
		this.statusValue = 'loading';
		this.resetGPUReferences();
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
		options?: WebGLWindLayerOptions
	);
	constructor(
		id: string,
		omUrl: string,
		domain: Domain,
		variable: string,
		options?: WebGLWindLayerOptions
	);
	constructor(
		id: string,
		sourceOrUrl: WebGLWeatherDataSource | string,
		domainOrVariable: Domain | string,
		variableOrOptions?: string | WebGLWindLayerOptions,
		legacyOptions?: WebGLWindLayerOptions
	) {
		this.id = id;
		if (sourceOrUrl instanceof WebGLWeatherDataSource) {
			this.source = sourceOrUrl;
			this.ownsSource = false;
			this.variable = domainOrVariable as string;
			this.options = this.resolveOptions(variableOrOptions as WebGLWindLayerOptions | undefined);
		} else {
			this.source = new WebGLWeatherDataSource(sourceOrUrl, domainOrVariable as Domain);
			this.ownsSource = true;
			this.variable = variableOrOptions as string;
			this.options = this.resolveOptions(legacyOptions);
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

	setOptions(options: Partial<WebGLWindLayerOptions>): void {
		const previousDensity = this.options.particleDensity;
		const previousMinimum = this.options.minParticles;
		const previousMaximum = this.options.maxParticles;
		this.options = this.resolveOptions({ ...this.options, ...options });
		this.colorScale = resolveWebGLColorScale(
			this.variable,
			this.options.colorScale,
			this.options.darkMode
		);
		if (this.gl && this.colorRampTexture) {
			this.gl.deleteTexture(this.colorRampTexture);
			this.colorRampTexture = createRampTexture(
				this.gl,
				createColorRampBytes(this.colorScale, this.options.colorBlend)
			);
		}
		if (
			this.gl &&
			(previousDensity !== this.options.particleDensity ||
				previousMinimum !== this.options.minParticles ||
				previousMaximum !== this.options.maxParticles)
		) {
			this.recreateParticles(this.gl);
		}
		this.clearTrails();
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

	prerender(
		glContext: WebGLRenderingContext | WebGL2RenderingContext,
		renderOptions: CustomRenderMethodInput
	): void {
		if (this.statusValue !== 'ready' || !this.map || !this.gl) return;
		if (!this.supportsCurrentProjection()) return;
		const gl = glContext as WebGL2RenderingContext;
		this.ensureScreenResources(gl);
		if (!this.trailTextures.length || !this.particleTextures.length) return;

		const now = performance.now();
		const realDelta = this.lastUpdateTime
			? Math.min(MAX_REAL_FRAME_DELTA, Math.max(0, (now - this.lastUpdateTime) / 1000))
			: 0;
		this.lastUpdateTime = now;

		const signature = this.getCameraSignature();
		if (signature !== this.cameraSignature) {
			this.cameraSignature = signature;
			this.clearTrails();
		}
		if (realDelta <= 0) return;

		const oldState = this.particleTextures[this.currentParticleTexture];
		const newState = this.particleTextures[1 - this.currentParticleTexture];
		try {
			this.updateParticles(gl, oldState, newState, realDelta, now / 1000);
			this.accumulateTrails(gl, oldState, newState, realDelta, renderOptions);
		} catch (error) {
			this.reportError(error);
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			return;
		}
		this.currentParticleTexture = 1 - this.currentParticleTexture;
		this.currentTrailTexture = 1 - this.currentTrailTexture;
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	}

	render(
		glContext: WebGLRenderingContext | WebGL2RenderingContext,
		_options: CustomRenderMethodInput
	): void {
		if (
			this.statusValue !== 'ready' ||
			!this.compositeProgram ||
			!this.quadBuffer ||
			!this.trailTextures.length ||
			!this.supportsCurrentProjection()
		) {
			return;
		}
		const gl = glContext as WebGL2RenderingContext;
		gl.useProgram(this.compositeProgram);
		this.bindQuad(gl, this.compositeProgram);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.trailTextures[this.currentTrailTexture]);
		gl.uniform1i(gl.getUniformLocation(this.compositeProgram, 'u_trail'), 0);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.drawArrays(gl.TRIANGLES, 0, 6);
		this.unbindQuad(gl, this.compositeProgram);
	}

	onRemove(_map: MapLibreMap, context: WebGLRenderingContext | WebGL2RenderingContext): void {
		this.statusValue = 'removed';
		this.abortController?.abort();
		if (this.animationFrame !== undefined) cancelAnimationFrame(this.animationFrame);
		this.map?.off('webglcontextlost', this.handleContextLost);
		this.map?.off('webglcontextrestored', this.handleContextRestored);
		this.destroyGPUResources(context as WebGL2RenderingContext);
		if (this.ownsSource) this.source.dispose();
		this.map = undefined;
		this.gl = undefined;
	}

	private resolveOptions(options: WebGLWindLayerOptions = {}): ResolvedWindOptions {
		const minimum = Math.max(1, Math.round(options.minParticles ?? 4096));
		const maximum = Math.max(minimum, Math.round(options.maxParticles ?? 65536));
		return {
			...options,
			simulationSpeed: Math.max(0, options.simulationSpeed ?? 1800),
			particleDensity: Math.max(0.00001, options.particleDensity ?? 0.01),
			minParticles: minimum,
			maxParticles: maximum,
			lineWidth: Math.max(0.5, options.lineWidth ?? 1.2),
			trailHalfLife: Math.max(0.05, options.trailHalfLife ?? 0.8),
			opacity: Math.max(0, Math.min(1, options.opacity ?? 0.8)),
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
		if (!gl.getExtension('EXT_color_buffer_float')) {
			throw new Error('Animated WebGL wind trails require the EXT_color_buffer_float extension.');
		}
		const descriptor = this.source.grid;
		if (!textureSizeSupported(gl, descriptor.nx, descriptor.ny)) {
			throw new Error(
				`Wind texture ${descriptor.nx}×${descriptor.ny} exceeds this device's MAX_TEXTURE_SIZE.`
			);
		}
		const floatLinear = Boolean(gl.getExtension('OES_texture_float_linear'));
		this.createPrograms(gl, !floatLinear);
		this.quadBuffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
		this.quadVertexArray = gl.createVertexArray()!;
		gl.bindVertexArray(this.quadVertexArray);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
		const quadPosition = gl.getAttribLocation(this.updateProgram!, 'a_position');
		gl.enableVertexAttribArray(quadPosition);
		gl.vertexAttribPointer(quadPosition, 2, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);
		this.segmentVertexArray = gl.createVertexArray()!;
		this.framebuffer = gl.createFramebuffer()!;

		const data = await this.source.loadWindVariable(this.variable, signal);
		if (signal.aborted || this.statusValue === 'removed') return;
		this.speedTexture = this.createFieldTexture(gl, data.values!, floatLinear);
		this.windUTexture = this.createFieldTexture(gl, data.u, floatLinear);
		this.windVTexture = this.createFieldTexture(gl, data.v, floatLinear);
		this.colorRampTexture = createRampTexture(
			gl,
			createColorRampBytes(this.colorScale, this.options.colorBlend)
		);
		this.ensureScreenResources(gl);
		this.recreateParticles(gl);
		this.statusValue = 'ready';
		this.options.onLoad?.();
		this.startAnimation();
	}

	private createPrograms(gl: WebGL2RenderingContext, manualLinear: boolean): void {
		const descriptor = this.source.grid;
		const gridShader = gridTransformShader(descriptor);
		const sampleShader = samplingShader(
			descriptor.nx,
			descriptor.ny,
			descriptor.longitudeWrap,
			manualLinear
		);
		const quadVertex = `#version 300 es
			layout(location = 0) in vec2 a_position;
			out vec2 v_uv;
			void main() {
				v_uv = a_position;
				gl_Position = vec4(a_position * 2.0 - 1.0, 0.0, 1.0);
			}`;

		this.updateProgram = createProgram(
			gl,
			quadVertex,
			`#version 300 es
			precision highp float;
			uniform sampler2D u_particles;
			uniform sampler2D u_wind_u;
			uniform sampler2D u_wind_v;
			uniform vec4 u_spawn_bounds;
			uniform float u_real_delta;
			uniform float u_simulation_delta;
			uniform float u_time;
			in vec2 v_uv;
			out vec4 fragmentColor;
			${gridShader}
			${sampleShader}
			const float EARTH_RADIUS = 6371000.0;
			bool validGrid(vec2 grid) {
				return grid.x >= -0.5 && grid.x <= ${descriptor.nx - 0.5} &&
					grid.y >= -0.5 && grid.y <= ${descriptor.ny - 0.5};
			}
			float random(vec2 value) {
				return fract(sin(dot(value, vec2(12.9898, 78.233))) * 43758.5453123);
			}
			vec2 windAt(vec2 lonLat, out bool valid) {
				vec2 grid = geographicToGrid(lonLat);
				valid = validGrid(grid);
				if (!valid) return vec2(0.0);
				float u = sampleField(u_wind_u, grid);
				float v = sampleField(u_wind_v, grid);
				valid = u == u && v == v &&
					abs(u) < 3.402823e38 && abs(v) < 3.402823e38;
				return vec2(u, v);
			}
			vec2 advect(vec2 lonLat, vec2 wind, float seconds) {
				float latitude = radians(lonLat.y);
				float dLat = degrees(wind.y * seconds / EARTH_RADIUS);
				float dLon = degrees(wind.x * seconds /
					(EARTH_RADIUS * max(0.01, cos(latitude))));
				return vec2(lonLat.x + dLon, clamp(lonLat.y + dLat, -85.05112878, 85.05112878));
			}
			vec4 respawn(vec2 seed) {
				vec2 position = u_spawn_bounds.xy;
				for (int attempt = 0; attempt < 8; attempt++) {
					vec2 attemptSeed = seed + float(attempt) * vec2(19.19, 73.73);
					vec2 randomPosition = vec2(
						random(attemptSeed + vec2(u_time, 17.0)),
						random(attemptSeed * 1.37 + vec2(31.0, u_time))
					);
					vec2 candidate = mix(u_spawn_bounds.xy, u_spawn_bounds.zw, randomPosition);
					bool candidateValid;
					windAt(candidate, candidateValid);
					position = candidate;
					if (candidateValid) break;
				}
				// Negative age explicitly marks a discontinuous respawn. The render
				// pass must never connect the previous position to this one.
				return vec4(position, -1.0, 4.0 + 4.0 * random(seed + 71.0));
			}
			void main() {
				vec4 particle = texture(u_particles, v_uv);
				vec2 position = particle.xy;
				if (particle.z < 0.0) {
					// Keep a newly spawned particle stationary for one update while
					// clearing its marker. Its first rendered segment begins next frame.
					fragmentColor = vec4(position, 0.0, particle.w);
					return;
				}
				float age = particle.z + u_real_delta;
				float life = particle.w;
				bool validStart;
				vec2 initialWind = windAt(position, validStart);
				vec2 midpoint = advect(position, initialWind, u_simulation_delta * 0.5);
				bool validMidpoint;
				vec2 midpointWind = windAt(midpoint, validMidpoint);
				vec2 nextPosition = advect(position, midpointWind, u_simulation_delta);
				bool inViewport =
					nextPosition.x >= u_spawn_bounds.x && nextPosition.x <= u_spawn_bounds.z &&
					nextPosition.y >= u_spawn_bounds.y && nextPosition.y <= u_spawn_bounds.w;
				float dropProbability = 1.0 - exp(-0.12 * u_real_delta);
				bool drop = random(v_uv + vec2(u_time, age)) < dropProbability;
				if (!validStart || !validMidpoint || !inViewport || age >= life || drop) {
					fragmentColor = respawn(v_uv + particle.ww);
				} else {
					fragmentColor = vec4(nextPosition, age, life);
				}
			}`
		);

		this.fadeProgram = createProgram(
			gl,
			quadVertex,
			`#version 300 es
			precision mediump float;
			uniform sampler2D u_previous;
			uniform float u_decay;
			in vec2 v_uv;
			out vec4 fragmentColor;
			void main() {
				fragmentColor = texture(u_previous, v_uv) * u_decay;
			}`
		);

		this.segmentProgram = createProgram(
			gl,
			`#version 300 es
			precision highp float;
			uniform sampler2D u_old_particles;
			uniform sampler2D u_new_particles;
			uniform sampler2D u_speed;
			uniform mat4 u_matrix;
			uniform vec2 u_viewport;
			uniform float u_particle_texture_size;
			uniform float u_line_width;
			uniform float u_max_segment_pixels;
			out float v_edge;
			out float v_speed;
			flat out float v_valid;
			${gridShader}
			${sampleShader}
			vec2 toMercator(vec2 lonLat) {
				float latitude = radians(clamp(lonLat.y, -85.05112878, 85.05112878));
				return vec2(
					lonLat.x / 360.0 + 0.5,
					0.5 - log(tan(0.7853981633974483 + latitude * 0.5)) / 6.283185307179586
				);
			}
			void main() {
				int textureSize = int(u_particle_texture_size);
				ivec2 particleCoordinate = ivec2(gl_InstanceID % textureSize, gl_InstanceID / textureSize);
				vec4 oldParticle = texelFetch(u_old_particles, particleCoordinate, 0);
				vec4 newParticle = texelFetch(u_new_particles, particleCoordinate, 0);
				bool finiteState =
					all(equal(oldParticle.xy, oldParticle.xy)) &&
					all(equal(newParticle.xy, newParticle.xy)) &&
					all(lessThan(abs(oldParticle.xy), vec2(3.402823e38))) &&
					all(lessThan(abs(newParticle.xy), vec2(3.402823e38)));
				bool continuous = oldParticle.z >= 0.0 && newParticle.z > oldParticle.z;
				vec4 oldClip = u_matrix * vec4(toMercator(oldParticle.xy), 0.0, 1.0);
				vec4 newClip = u_matrix * vec4(toMercator(newParticle.xy), 0.0, 1.0);
				bool finiteClip =
					all(equal(oldClip, oldClip)) &&
					all(equal(newClip, newClip)) &&
					all(lessThan(abs(oldClip), vec4(3.402823e38))) &&
					all(lessThan(abs(newClip), vec4(3.402823e38))) &&
					oldClip.w > 0.000001 && newClip.w > 0.000001;
				if (!finiteState || !continuous || !finiteClip) {
					gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
					v_edge = 0.0;
					v_speed = 0.0;
					v_valid = 0.0;
					return;
				}
				vec2 oldNdc = oldClip.xy / oldClip.w;
				vec2 newNdc = newClip.xy / newClip.w;
				vec2 pixelDirection = (newNdc - oldNdc) * u_viewport * 0.5;
				float segmentLength = length(pixelDirection);
				if (segmentLength != segmentLength || segmentLength > u_max_segment_pixels) {
					gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
					v_edge = 0.0;
					v_speed = 0.0;
					v_valid = 0.0;
					return;
				}
				v_valid = 1.0;
				vec2 normal = length(pixelDirection) > 0.001
					? normalize(vec2(-pixelDirection.y, pixelDirection.x))
					: vec2(0.0, 1.0);
				bool atOld = gl_VertexID == 0 || gl_VertexID == 1 || gl_VertexID == 4;
				bool negativeSide = gl_VertexID == 0 || gl_VertexID == 2 || gl_VertexID == 3;
				float endpoint = atOld ? 0.0 : 1.0;
				float side = negativeSide ? -1.0 : 1.0;
				vec4 clip = mix(oldClip, newClip, endpoint);
				vec2 offset = normal * side * u_line_width * 2.0 / u_viewport;
				clip.xy += offset * clip.w;
				gl_Position = clip;
				v_edge = side;
				vec2 grid = geographicToGrid(newParticle.xy);
				v_speed = sampleField(u_speed, grid);
			}`,
			`#version 300 es
			precision mediump float;
			uniform sampler2D u_color_ramp;
			uniform vec2 u_value_range;
			uniform float u_opacity;
			in float v_edge;
			in float v_speed;
			flat in float v_valid;
			out vec4 fragmentColor;
			void main() {
				if (v_valid < 0.5 || v_speed != v_speed) discard;
				float normalized = clamp(
					(v_speed - u_value_range.x) / max(0.000001, u_value_range.y - u_value_range.x),
					0.0,
					1.0
				);
				vec4 color = texture(u_color_ramp, vec2(normalized, 0.5));
				float coverage = 1.0 - smoothstep(0.65, 1.0, abs(v_edge));
				color.a *= coverage * u_opacity;
				color.rgb *= color.a;
				fragmentColor = color;
			}`
		);

		this.compositeProgram = createProgram(
			gl,
			quadVertex,
			`#version 300 es
			precision mediump float;
			uniform sampler2D u_trail;
			in vec2 v_uv;
			out vec4 fragmentColor;
			void main() {
				fragmentColor = texture(u_trail, v_uv);
			}`
		);
	}

	private createFieldTexture(
		gl: WebGL2RenderingContext,
		values: Float32Array,
		linear: boolean
	): WebGLTexture {
		const descriptor = this.source.grid;
		const texture = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(
			gl.TEXTURE_2D,
			gl.TEXTURE_WRAP_S,
			descriptor.longitudeWrap ? gl.REPEAT : gl.CLAMP_TO_EDGE
		);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
		gl.texImage2D(
			gl.TEXTURE_2D,
			0,
			gl.R32F,
			descriptor.nx,
			descriptor.ny,
			0,
			gl.RED,
			gl.FLOAT,
			values
		);
		if (gl.getError() !== gl.NO_ERROR) throw new Error('Failed to upload a wind field texture.');
		return texture;
	}

	private ensureScreenResources(gl: WebGL2RenderingContext): void {
		const canvas = gl.canvas as HTMLCanvasElement;
		if (
			canvas.width === this.trailWidth &&
			canvas.height === this.trailHeight &&
			this.trailTextures.length
		) {
			return;
		}
		for (const texture of this.trailTextures) gl.deleteTexture(texture);
		this.trailTextures = [
			this.createTrailTexture(gl, canvas.width, canvas.height),
			this.createTrailTexture(gl, canvas.width, canvas.height)
		];
		this.trailWidth = canvas.width;
		this.trailHeight = canvas.height;
		this.currentTrailTexture = 0;
		this.clearTrails();
		if (this.statusValue === 'ready') this.recreateParticles(gl);
	}

	private createTrailTexture(
		gl: WebGL2RenderingContext,
		width: number,
		height: number
	): WebGLTexture {
		const texture = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		return texture;
	}

	private recreateParticles(gl: WebGL2RenderingContext): void {
		if (!this.map) return;
		for (const texture of this.particleTextures) gl.deleteTexture(texture);
		const canvas = gl.canvas as HTMLCanvasElement;
		const cssWidth = canvas.clientWidth || canvas.width;
		const cssHeight = canvas.clientHeight || canvas.height;
		this.particleCount = computeParticleCount(
			cssWidth,
			cssHeight,
			this.options.particleDensity,
			this.options.minParticles,
			this.options.maxParticles
		);
		this.particleTextureSize = Math.ceil(Math.sqrt(this.particleCount));
		const data = this.initialParticleData(this.particleTextureSize ** 2);
		this.particleTextures = [
			this.createParticleTexture(gl, data),
			this.createParticleTexture(gl, data)
		];
		this.currentParticleTexture = 0;
		this.lastUpdateTime = undefined;
	}

	private createParticleTexture(gl: WebGL2RenderingContext, data: Float32Array): WebGLTexture {
		const texture = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texImage2D(
			gl.TEXTURE_2D,
			0,
			gl.RGBA32F,
			this.particleTextureSize,
			this.particleTextureSize,
			0,
			gl.RGBA,
			gl.FLOAT,
			data
		);
		return texture;
	}

	private initialParticleData(count: number): Float32Array {
		const spawn = this.getSpawnBounds();
		const data = new Float32Array(count * 4);
		for (let index = 0; index < count; index++) {
			const offset = index * 4;
			data[offset] = spawn[0] + Math.random() * (spawn[2] - spawn[0]);
			data[offset + 1] = spawn[1] + Math.random() * (spawn[3] - spawn[1]);
			data[offset + 2] = Math.random() * 6;
			data[offset + 3] = 4 + Math.random() * 4;
		}
		return data;
	}

	private updateParticles(
		gl: WebGL2RenderingContext,
		oldState: WebGLTexture,
		newState: WebGLTexture,
		realDelta: number,
		time: number
	): void {
		const program = this.updateProgram!;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer!);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, newState, 0);
		if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
			throw new Error('Wind particle framebuffer is incomplete.');
		}
		gl.viewport(0, 0, this.particleTextureSize, this.particleTextureSize);
		gl.disable(gl.BLEND);
		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.STENCIL_TEST);
		gl.useProgram(program);
		this.bindQuad(gl, program);
		this.bindTextureUniform(gl, program, 'u_particles', oldState, 0);
		this.bindTextureUniform(gl, program, 'u_wind_u', this.windUTexture!, 1);
		this.bindTextureUniform(gl, program, 'u_wind_v', this.windVTexture!, 2);
		const spawn = this.getSpawnBounds();
		gl.uniform4f(gl.getUniformLocation(program, 'u_spawn_bounds'), ...spawn);
		gl.uniform1f(gl.getUniformLocation(program, 'u_real_delta'), realDelta);
		gl.uniform1f(
			gl.getUniformLocation(program, 'u_simulation_delta'),
			realDelta * this.options.simulationSpeed
		);
		gl.uniform1f(gl.getUniformLocation(program, 'u_time'), time);
		gl.drawArrays(gl.TRIANGLES, 0, 6);
		this.unbindQuad(gl, program);
	}

	private accumulateTrails(
		gl: WebGL2RenderingContext,
		oldState: WebGLTexture,
		newState: WebGLTexture,
		realDelta: number,
		renderOptions: CustomRenderMethodInput
	): void {
		const previousTrail = this.trailTextures[this.currentTrailTexture];
		const nextTrail = this.trailTextures[1 - this.currentTrailTexture];
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer!);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, nextTrail, 0);
		gl.viewport(0, 0, this.trailWidth, this.trailHeight);
		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.STENCIL_TEST);

		gl.disable(gl.BLEND);
		gl.useProgram(this.fadeProgram!);
		this.bindQuad(gl, this.fadeProgram!);
		this.bindTextureUniform(gl, this.fadeProgram!, 'u_previous', previousTrail, 0);
		const decay = Math.pow(0.5, realDelta / this.options.trailHalfLife);
		gl.uniform1f(gl.getUniformLocation(this.fadeProgram!, 'u_decay'), decay);
		gl.drawArrays(gl.TRIANGLES, 0, 6);
		this.unbindQuad(gl, this.fadeProgram!);

		const program = this.segmentProgram!;
		gl.useProgram(program);
		this.bindTextureUniform(gl, program, 'u_old_particles', oldState, 0);
		this.bindTextureUniform(gl, program, 'u_new_particles', newState, 1);
		this.bindTextureUniform(gl, program, 'u_speed', this.speedTexture!, 2);
		this.bindTextureUniform(gl, program, 'u_color_ramp', this.colorRampTexture!, 3);
		gl.uniformMatrix4fv(
			gl.getUniformLocation(program, 'u_matrix'),
			false,
			renderOptions.defaultProjectionData.mainMatrix
		);
		gl.uniform2f(gl.getUniformLocation(program, 'u_viewport'), this.trailWidth, this.trailHeight);
		gl.uniform1f(
			gl.getUniformLocation(program, 'u_particle_texture_size'),
			this.particleTextureSize
		);
		const pixelRatio = this.trailWidth / Math.max(1, (gl.canvas as HTMLCanvasElement).clientWidth);
		gl.uniform1f(
			gl.getUniformLocation(program, 'u_line_width'),
			this.options.lineWidth * pixelRatio * 0.5
		);
		gl.uniform1f(gl.getUniformLocation(program, 'u_max_segment_pixels'), 100 * pixelRatio);
		const range = colorScaleRange(this.colorScale);
		gl.uniform2f(gl.getUniformLocation(program, 'u_value_range'), range[0], range[1]);
		gl.uniform1f(gl.getUniformLocation(program, 'u_opacity'), this.options.opacity);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		gl.bindVertexArray(this.segmentVertexArray!);
		gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.particleCount);
		gl.bindVertexArray(null);
	}

	private bindQuad(gl: WebGL2RenderingContext, _program: WebGLProgram): void {
		gl.bindVertexArray(this.quadVertexArray!);
	}

	private unbindQuad(gl: WebGL2RenderingContext, _program: WebGLProgram): void {
		gl.bindVertexArray(null);
	}

	private bindTextureUniform(
		gl: WebGL2RenderingContext,
		program: WebGLProgram,
		name: string,
		texture: WebGLTexture,
		unit: number
	): void {
		gl.activeTexture(gl.TEXTURE0 + unit);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.uniform1i(gl.getUniformLocation(program, name), unit);
	}

	private getSpawnBounds(): [number, number, number, number] {
		const domain = this.source.grid.bounds;
		if (!this.map) return [domain[0], domain[1], domain[2], domain[3]];
		const viewport = this.map.getBounds();
		const domainCenter = (domain[0] + domain[2]) * 0.5;
		const world = Math.round((this.map.getCenter().lng - domainCenter) / 360) * 360;
		const shiftedWest = domain[0] + world;
		const shiftedEast = domain[2] + world;
		const west = Math.max(viewport.getWest(), shiftedWest);
		const south = Math.max(viewport.getSouth(), domain[1]);
		const east = Math.min(viewport.getEast(), shiftedEast);
		const north = Math.min(viewport.getNorth(), domain[3]);
		return west < east && south < north
			? [west, south, east, north]
			: [shiftedWest, domain[1], shiftedEast, domain[3]];
	}

	private getCameraSignature(): string {
		if (!this.map || !this.gl) return '';
		const center = this.map.getCenter();
		const canvas = this.gl.canvas as HTMLCanvasElement;
		return [
			center.lng.toFixed(7),
			center.lat.toFixed(7),
			this.map.getZoom().toFixed(5),
			this.map.getBearing().toFixed(3),
			this.map.getPitch().toFixed(3),
			canvas.width,
			canvas.height
		].join(':');
	}

	private supportsCurrentProjection(): boolean {
		if (!this.map || (this.map.getProjection()?.type ?? 'mercator') === 'mercator') {
			this.projectionErrorReported = false;
			return true;
		}
		if (!this.projectionErrorReported) {
			this.projectionErrorReported = true;
			const error = new Error(
				'Animated WebGL wind trails currently support MapLibre Mercator projection only.'
			);
			if (this.options.onError) this.options.onError(error);
			else console.error(`[WebGLWindLayer:${this.id}]`, error);
		}
		return false;
	}

	private clearTrails(): void {
		if (!this.gl || !this.framebuffer || !this.trailTextures.length) return;
		const gl = this.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
		gl.viewport(0, 0, this.trailWidth, this.trailHeight);
		gl.clearColor(0, 0, 0, 0);
		for (const texture of this.trailTextures) {
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	}

	private startAnimation(): void {
		const animate = () => {
			if (this.statusValue !== 'ready') return;
			this.map?.triggerRepaint();
			this.animationFrame = requestAnimationFrame(animate);
		};
		this.animationFrame = requestAnimationFrame(animate);
	}

	private destroyGPUResources(gl: WebGL2RenderingContext): void {
		for (const program of [
			this.updateProgram,
			this.fadeProgram,
			this.segmentProgram,
			this.compositeProgram
		]) {
			if (program) gl.deleteProgram(program);
		}
		if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
		if (this.quadVertexArray) gl.deleteVertexArray(this.quadVertexArray);
		if (this.segmentVertexArray) gl.deleteVertexArray(this.segmentVertexArray);
		if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
		for (const texture of [
			this.speedTexture,
			this.windUTexture,
			this.windVTexture,
			this.colorRampTexture,
			...this.particleTextures,
			...this.trailTextures
		]) {
			if (texture) gl.deleteTexture(texture);
		}
		this.particleTextures = [];
		this.trailTextures = [];
		this.resetGPUReferences();
	}

	private resetGPUReferences(): void {
		this.updateProgram = undefined;
		this.fadeProgram = undefined;
		this.segmentProgram = undefined;
		this.compositeProgram = undefined;
		this.quadBuffer = undefined;
		this.quadVertexArray = undefined;
		this.segmentVertexArray = undefined;
		this.framebuffer = undefined;
		this.speedTexture = undefined;
		this.windUTexture = undefined;
		this.windVTexture = undefined;
		this.colorRampTexture = undefined;
		this.particleTextures = [];
		this.trailTextures = [];
		this.trailWidth = 0;
		this.trailHeight = 0;
	}

	private reportError(error: unknown): void {
		const resolved = error instanceof Error ? error : new Error(String(error));
		this.statusValue = 'error';
		if (this.animationFrame !== undefined) cancelAnimationFrame(this.animationFrame);
		if (this.options.onError) this.options.onError(resolved);
		else console.error(`[WebGLWindLayer:${this.id}]`, resolved);
	}
}
