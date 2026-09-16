/**
 * Offscreen target making the terrain-draped layer a solid, single-sided
 * surface. Drawn straight onto the map without a depth test, every part of
 * the lifted mesh shows: the far slope of a ridge blends through the near
 * one and the sheet looks see-through. MapLibre's own depth buffer is not
 * ours to write, so the layer renders into this target instead: a depth
 * pre-pass of the surface first, then every colour pass depth-tested against
 * it (LEQUAL — identical geometry, `invariant gl_Position`), so only the
 * nearest surface fragment survives; the result is composited onto the map
 * premultiplied, exactly like a direct draw would have blended.
 */
import type { GpuDrawOptions, WeatherGpuRenderer } from './renderer';
import type { GpuVisibilityMap } from './terrain-elevation';

/** Largest edge of the visibility map. */
const VISIBILITY_MAX_SIZE = 1024;

const COMPOSITE_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
	vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	v_uv = p;
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const COMPOSITE_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_surface;
out vec4 outColor;
void main() {
	outColor = texture(u_surface, v_uv);
}
`;

export class SurfaceTarget {
	private gl: WebGL2RenderingContext;
	private texture: WebGLTexture | null = null;
	/** Depth texture: sampled by the visibility pass, shared with the trails. */
	private depth: WebGLTexture | null = null;
	private fbo: WebGLFramebuffer | null = null;
	/** Screen-space ground map (mercator xy, y = 0 off ground), pre-pass target. */
	private ground: WebGLTexture | null = null;
	private groundFbo: WebGLFramebuffer | null = null;
	private width = 0;
	private height = 0;
	private visibility:
		{ texture: WebGLTexture; fbo: WebGLFramebuffer; width: number; height: number } | undefined;
	private visibilityMap: GpuVisibilityMap | undefined;
	private composite: { program: WebGLProgram; surface: WebGLUniformLocation | null } | undefined;
	private vao: WebGLVertexArrayObject | null = null;
	private saved:
		| {
				fbo: WebGLFramebuffer | null;
				viewport: Int32Array;
				depthOn: boolean;
				depthMask: boolean;
				depthFunc: number;
		  }
		| undefined;

	constructor(gl: WebGL2RenderingContext) {
		this.gl = gl;
	}

	/**
	 * Redirect drawing into the target: clears it, runs the depth pre-pass of
	 * the surface and leaves the depth test armed for the colour passes.
	 */
	begin(
		renderer: WeatherGpuRenderer,
		projection: NonNullable<GpuDrawOptions['projection']>,
		worldOffsets: number[]
	): void {
		const gl = this.gl;
		this.saved = {
			fbo: gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
			viewport: gl.getParameter(gl.VIEWPORT) as Int32Array,
			depthOn: gl.isEnabled(gl.DEPTH_TEST),
			depthMask: gl.getParameter(gl.DEPTH_WRITEMASK) as boolean,
			depthFunc: gl.getParameter(gl.DEPTH_FUNC) as number
		};
		this.ensureTarget(gl.drawingBufferWidth, gl.drawingBufferHeight);
		gl.viewport(0, 0, this.width, this.height);
		gl.clearColor(0, 0, 0, 0);
		gl.clearDepth(1);
		gl.depthMask(true);

		// Pre-pass: the surface depth (shared with the colour target) and the
		// ground map.
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.groundFbo);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LESS);
		renderer.drawSurfaceDepth(projection, worldOffsets);

		this.renderVisibility(renderer, projection);

		// Colour passes: same geometry, so equal depths pass; nothing farther.
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
		gl.viewport(0, 0, this.width, this.height);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
		gl.depthMask(false);
	}

	/**
	 * Which ground is visible, in mercator space: the particle update pass
	 * respawns particles that sit on hidden ground, so the population lives
	 * on the visible parts only.
	 */
	private renderVisibility(
		renderer: WeatherGpuRenderer,
		projection: NonNullable<GpuDrawOptions['projection']>
	): void {
		const gl = this.gl;
		const elevation = projection.elevation!;
		const [x0, y0, x1, y1] = elevation.bounds;
		const scale = VISIBILITY_MAX_SIZE / Math.max(x1 - x0, y1 - y0);
		const width = Math.max(1, Math.round((x1 - x0) * scale));
		const height = Math.max(1, Math.round((y1 - y0) * scale));
		const vis = this.ensureVisibility(width, height);
		const depthRange = gl.getParameter(gl.DEPTH_RANGE) as Float32Array;
		gl.bindFramebuffer(gl.FRAMEBUFFER, vis.fbo);
		gl.viewport(0, 0, width, height);
		gl.disable(gl.DEPTH_TEST);
		renderer.drawSurfaceVisibility(projection, this.depth!, [depthRange[0], depthRange[1]]);
		this.visibilityMap = { texture: vis.texture, rect: elevation.rect };
	}

	/** Composite the target onto the framebuffer that was bound at begin(). */
	end(): void {
		const gl = this.gl;
		const saved = this.saved;
		if (!saved) return;
		this.saved = undefined;
		if (saved.depthOn) gl.enable(gl.DEPTH_TEST);
		else gl.disable(gl.DEPTH_TEST);
		gl.depthMask(saved.depthMask);
		gl.depthFunc(saved.depthFunc);
		gl.bindFramebuffer(gl.FRAMEBUFFER, saved.fbo);
		gl.viewport(saved.viewport[0], saved.viewport[1], saved.viewport[2], saved.viewport[3]);

		const composite = this.getComposite();
		gl.useProgram(composite.program);
		this.vao ??= gl.createVertexArray();
		gl.bindVertexArray(this.vao);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.uniform1i(composite.surface, 0);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.bindVertexArray(null);
	}

	/**
	 * The surface depth texture, for passes rendering into their own
	 * framebuffer (the particle trails) to occlude against. Valid between
	 * begin and end.
	 */
	get depthTexture(): WebGLTexture | undefined {
		return this.depth ?? undefined;
	}

	/** The ground visibility map of this frame. Valid between begin and end. */
	get visibilityMapOfFrame(): GpuVisibilityMap | undefined {
		return this.visibilityMap;
	}

	/**
	 * Screen-space ground map of this frame: the mercator position of the
	 * surface under each pixel (y = 0 where there is none). Valid between
	 * begin and end.
	 */
	get groundMap(): WebGLTexture | undefined {
		return this.ground ?? undefined;
	}

	/** Run `fn` with the depth test off (screen-space passes inside the target). */
	withoutDepth(fn: () => void): void {
		const gl = this.gl;
		const depthOn = gl.isEnabled(gl.DEPTH_TEST);
		gl.disable(gl.DEPTH_TEST);
		fn();
		if (depthOn) gl.enable(gl.DEPTH_TEST);
	}

	dispose(): void {
		const gl = this.gl;
		this.deleteTargets();
		if (this.visibility) {
			gl.deleteTexture(this.visibility.texture);
			gl.deleteFramebuffer(this.visibility.fbo);
			this.visibility = undefined;
		}
		this.visibilityMap = undefined;
		if (this.composite) gl.deleteProgram(this.composite.program);
		this.composite = undefined;
		if (this.vao) gl.deleteVertexArray(this.vao);
		this.vao = null;
	}

	private deleteTargets(): void {
		const gl = this.gl;
		if (this.texture) gl.deleteTexture(this.texture);
		if (this.depth) gl.deleteTexture(this.depth);
		if (this.ground) gl.deleteTexture(this.ground);
		if (this.fbo) gl.deleteFramebuffer(this.fbo);
		if (this.groundFbo) gl.deleteFramebuffer(this.groundFbo);
		this.texture = null;
		this.depth = null;
		this.ground = null;
		this.fbo = null;
		this.groundFbo = null;
		this.width = 0;
		this.height = 0;
	}

	private ensureTarget(width: number, height: number): void {
		const gl = this.gl;
		if (this.fbo && this.width === width && this.height === height) return;
		this.deleteTargets();
		const texture = this.createTexture(width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
		const depth = this.createTexture(
			width,
			height,
			gl.DEPTH_COMPONENT24,
			gl.DEPTH_COMPONENT,
			gl.UNSIGNED_INT
		);
		// Mercator positions need float precision (RG32F is renderable with
		// EXT_color_buffer_float, which the elevation map already requires).
		const ground = this.createTexture(width, height, gl.RG32F, gl.RG, gl.FLOAT);
		const fbo = gl.createFramebuffer();
		const groundFbo = gl.createFramebuffer();
		if (!fbo || !groundFbo) throw new Error('gpu: could not create surface target');
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
		gl.bindFramebuffer(gl.FRAMEBUFFER, groundFbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ground, 0);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
		this.ground = ground;
		this.groundFbo = groundFbo;
		this.texture = texture;
		this.depth = depth;
		this.fbo = fbo;
		this.width = width;
		this.height = height;
	}

	private ensureVisibility(
		width: number,
		height: number
	): NonNullable<SurfaceTarget['visibility']> {
		const gl = this.gl;
		const vis = this.visibility;
		if (vis && vis.width === width && vis.height === height) return vis;
		if (vis) {
			gl.deleteTexture(vis.texture);
			gl.deleteFramebuffer(vis.fbo);
		}
		const texture = this.createTexture(width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
		const fbo = gl.createFramebuffer();
		if (!fbo) throw new Error('gpu: could not create visibility target');
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
		this.visibility = { texture, fbo, width, height };
		return this.visibility;
	}

	private createTexture(
		width: number,
		height: number,
		internalFormat: number,
		format: number,
		type: number
	): WebGLTexture {
		const gl = this.gl;
		const texture = gl.createTexture();
		if (!texture) throw new Error('gpu: could not create texture');
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);
		return texture;
	}

	private getComposite(): NonNullable<SurfaceTarget['composite']> {
		if (this.composite) return this.composite;
		const gl = this.gl;
		const compile = (type: number, source: string): WebGLShader => {
			const shader = gl.createShader(type);
			if (!shader) throw new Error('gpu: could not create shader');
			gl.shaderSource(shader, source);
			gl.compileShader(shader);
			if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
				const log = gl.getShaderInfoLog(shader);
				gl.deleteShader(shader);
				throw new Error(`gpu: surface composite shader compile failed: ${log}`);
			}
			return shader;
		};
		const program = gl.createProgram();
		if (!program) throw new Error('gpu: could not create surface composite program');
		gl.attachShader(program, compile(gl.VERTEX_SHADER, COMPOSITE_VERTEX));
		gl.attachShader(program, compile(gl.FRAGMENT_SHADER, COMPOSITE_FRAGMENT));
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			const log = gl.getProgramInfoLog(program);
			gl.deleteProgram(program);
			throw new Error(`gpu: surface composite program link failed: ${log}`);
		}
		this.composite = { program, surface: gl.getUniformLocation(program, 'u_surface') };
		return this.composite;
	}
}
