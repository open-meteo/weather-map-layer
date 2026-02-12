import { CustomLayerInterface, CustomRenderMethodInput, Map } from 'maplibre-gl';

import { GridFactory } from './grids';
import { WeatherMapLayerFileReader } from './om-file-reader';

import { Domain } from './types';

export class WebGLWindLayer implements CustomLayerInterface {
	id: string;
	type: 'custom' = 'custom' as const;
	renderingMode: '2d' = '2d' as const;

	private map: Map | undefined;
	private gl: WebGL2RenderingContext | undefined;
	private program: WebGLProgram | undefined;
	private windUTexture: WebGLTexture | undefined;
	private windVTexture: WebGLTexture | undefined;
	private particleStateTexture: WebGLTexture | undefined;
	private particleNextStateTexture: WebGLTexture | undefined;
	private framebuffer: WebGLFramebuffer | undefined;
	private particleVertexBuffer: WebGLBuffer | undefined;
	private backgroundVertexBuffer: WebGLBuffer | undefined;
	private backgroundIndexBuffer: WebGLBuffer | undefined;

	private omUrl: string;
	private omFileReader: WeatherMapLayerFileReader;
	private domain: Domain;
	private variable: string;
	private dataLoaded = false;
	private backgroundVertexCount = 0;

	// Animation parameters
	private numParticles = 65536; // Must be a perfect square for texture dimensions
	private particleTextureSize = 256; // sqrt(65536) = 256
	private speedFactor = 0.8;
	private dropRate = 0.003;
	private animationTime = 0;

	constructor(id: string, omUrl: string, domain: Domain, variable: string) {
		this.id = id;
		this.domain = domain;
		this.variable = variable;
		this.omUrl = omUrl;
		this.omFileReader = new WeatherMapLayerFileReader();
	}

	private getBounds() {
		const grid = GridFactory.create(this.domain.grid);
		return grid.getBounds();
	}

	private createBackgroundMesh(resolution: number = 50): {
		vertices: Float32Array;
		indices: Uint16Array;
	} {
		const vertices: number[] = [];
		const indices: number[] = [];

		// Create a grid of vertices for the background mesh
		for (let y = 0; y <= resolution; y++) {
			for (let x = 0; x <= resolution; x++) {
				const u = x / resolution;
				const v = y / resolution;
				vertices.push(u, v, u, v); // position (u,v), texCoord (u,v)
			}
		}

		// Create triangle indices
		for (let y = 0; y < resolution; y++) {
			for (let x = 0; x < resolution; x++) {
				const topLeft = y * (resolution + 1) + x;
				const topRight = topLeft + 1;
				const bottomLeft = (y + 1) * (resolution + 1) + x;
				const bottomRight = bottomLeft + 1;

				indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
			}
		}

		this.backgroundVertexCount = indices.length;
		return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
	}

	private createParticleVertices(): Float32Array {
		const vertices: number[] = [];

		// Create vertices for particle rendering (simple points)
		for (let i = 0; i < this.numParticles; i++) {
			const x = (i % this.particleTextureSize) / this.particleTextureSize;
			const y = Math.floor(i / this.particleTextureSize) / this.particleTextureSize;
			vertices.push(x, y); // Texture coordinates to sample particle state
		}

		return new Float32Array(vertices);
	}

	private getZoomAdjustedParameters() {
		const zoom = this.map?.getZoom() || 0;

		// Increase drop rate and reduce life at higher zoom levels
		const zoomFactor = Math.max(1, zoom - 2) / 10;

		return {
			dropRate: this.dropRate * (1 + zoomFactor * 2),
			speedFactor: this.speedFactor * (1 + zoomFactor * 0.1)
		};
	}

	private initializeParticles(): Float32Array {
		const data = new Float32Array(this.numParticles * 4); // RGBA

		for (let i = 0; i < this.numParticles; i++) {
			const idx = i * 4;
			// x, y position (normalized 0-1)
			data[idx] = Math.random();
			data[idx + 1] = Math.random();
			// age and life (for particle lifecycle)
			data[idx + 2] = Math.random() * 100; // age
			data[idx + 3] = 100; // max life
		}

		console.log('Initialized particles:', {
			totalParticles: this.numParticles,
			dataLength: data.length,
			samplePositions: [
				{ x: data[0], y: data[1], age: data[2], life: data[3] },
				{ x: data[4], y: data[5], age: data[6], life: data[7] },
				{ x: data[8], y: data[9], age: data[10], life: data[11] }
			]
		});

		return data;
	}

	async onAdd(map: Map, gl: WebGL2RenderingContext): Promise<void> {
		this.gl = gl;
		this.map = map;

		// Enable required extensions explicitly
		const floatLinearExt = gl.getExtension('OES_texture_float_linear');
		const floatBlendExt = gl.getExtension('EXT_float_blend');

		if (!floatLinearExt) {
			console.warn('Float linear filtering not supported');
		}
		if (!floatBlendExt) {
			console.warn('Float blend extension not supported');
		}

		// Load wind data
		await this.omFileReader.setToOmFile(this.omUrl);
		await this.loadWindData(map);

		// Create shaders and program
		const vertexShaderUpdate = this.createShader(
			gl,
			gl.VERTEX_SHADER,
			this.getUpdateVertexShader()
		);
		const fragmentShaderUpdate = this.createShader(
			gl,
			gl.FRAGMENT_SHADER,
			this.getUpdateFragmentShader()
		);

		this.program = gl.createProgram()!;
		gl.attachShader(this.program, vertexShaderUpdate);
		gl.attachShader(this.program, fragmentShaderUpdate);
		gl.linkProgram(this.program);

		if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
			console.error('Program link error:', gl.getProgramInfoLog(this.program));
		}

		// Create buffers
		const backgroundMesh = this.createBackgroundMesh();

		this.backgroundVertexBuffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.backgroundVertexBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, backgroundMesh.vertices, gl.STATIC_DRAW);

		this.backgroundIndexBuffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.backgroundIndexBuffer);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, backgroundMesh.indices, gl.STATIC_DRAW);

		this.particleVertexBuffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.particleVertexBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, this.createParticleVertices(), gl.STATIC_DRAW);

		// Create particle state textures
		this.particleStateTexture = this.createParticleTexture(gl);
		this.particleNextStateTexture = this.createParticleTexture(gl);

		// Create framebuffer for particle updates
		this.framebuffer = gl.createFramebuffer()!;

		// Test framebuffer completeness
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
		gl.framebufferTexture2D(
			gl.FRAMEBUFFER,
			gl.COLOR_ATTACHMENT0,
			gl.TEXTURE_2D,
			this.particleNextStateTexture,
			0
		);

		const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
		if (status !== gl.FRAMEBUFFER_COMPLETE) {
			console.error('Framebuffer not complete:', status);
		} else {
			console.log('Framebuffer is complete');
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);

		// Start animation loop
		this.startAnimation();
	}

	private createParticleTexture(gl: WebGL2RenderingContext): WebGLTexture {
		const texture = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

		const initialData = this.initializeParticles();
		gl.texImage2D(
			gl.TEXTURE_2D,
			0,
			gl.RGBA32F,
			this.particleTextureSize,
			this.particleTextureSize,
			0,
			gl.RGBA,
			gl.FLOAT,
			initialData
		);

		// Check for errors
		const error = gl.getError();
		if (error !== gl.NO_ERROR) {
			console.error('Error creating particle texture:', error);
		}

		return texture;
	}

	private async loadWindData(map: Map): Promise<void> {
		console.log('Loading wind data...');

		const data = await this.omFileReader.readVariable(this.variable, [
			{ start: 0, end: this.domain.grid.ny },
			{ start: 0, end: this.domain.grid.nx }
		]);
		console.log(data);

		// For now we implemented a small hack in the reader to get raw u and v values
		const uValues = data.values!;
		const vValues = data.directions!;

		if (!this.gl || !data.values || !data.directions) return;

		const { nx, ny } = this.domain.grid;
		const gl = this.gl;

		// Create U wind component texture
		this.windUTexture = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, this.windUTexture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, nx, ny, 0, gl.RED, gl.FLOAT, uValues);

		// Create V wind component texture
		this.windVTexture = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, this.windVTexture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, nx, ny, 0, gl.RED, gl.FLOAT, vValues);

		// Check for GL errors
		const error = gl.getError();
		if (error !== gl.NO_ERROR) {
			console.error('WebGL error after wind texture upload:', error);
		}

		this.dataLoaded = true;
		console.log('Wind data loaded successfully');
		map.triggerRepaint();
	}

	private startAnimation(): void {
		const animate = () => {
			this.animationTime += 0.016; // ~60fps
			if (this.map) {
				this.map.triggerRepaint();
			}
			requestAnimationFrame(animate);
		};
		animate();
	}

	render(gl: WebGLRenderingContext, options: CustomRenderMethodInput): void {
		if (!this.program || !this.dataLoaded) {
			return;
		}

		// Update particles
		this.updateParticles(gl as WebGL2RenderingContext, options);

		// Render particles
		this.renderParticles(gl as WebGL2RenderingContext, options);
	}

	private updateParticles(gl: WebGL2RenderingContext, _options: CustomRenderMethodInput): void {
		// Disable blending for the update pass
		// The particle update step is a pure data-writing operation.
		// Blending should be off to ensure the exact RGBA values calculated in the
		// shader are written to the new state texture without being modified.
		// We re-enable it before the render pass.
		gl.disable(gl.BLEND);

		// Switch to framebuffer for particle update
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer!);
		gl.framebufferTexture2D(
			gl.FRAMEBUFFER,
			gl.COLOR_ATTACHMENT0,
			gl.TEXTURE_2D,
			this.particleNextStateTexture!,
			0
		);

		gl.viewport(0, 0, this.particleTextureSize, this.particleTextureSize);

		gl.useProgram(this.program!);

		// Bind wind textures
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.windUTexture!);
		gl.uniform1i(gl.getUniformLocation(this.program!, 'u_wind_u'), 0);

		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.windVTexture!);
		gl.uniform1i(gl.getUniformLocation(this.program!, 'u_wind_v'), 1);

		gl.activeTexture(gl.TEXTURE2);
		gl.bindTexture(gl.TEXTURE_2D, this.particleStateTexture!);
		gl.uniform1i(gl.getUniformLocation(this.program!, 'u_particles'), 2);

		// Set uniforms
		const bounds = this.getBounds();
		gl.uniform4f(
			gl.getUniformLocation(this.program!, 'u_bounds'),
			bounds[0],
			bounds[1],
			bounds[2],
			bounds[3]
		);
		const params = this.getZoomAdjustedParameters();
		gl.uniform1f(gl.getUniformLocation(this.program!, 'u_drop_rate'), params.dropRate);
		gl.uniform1f(gl.getUniformLocation(this.program!, 'u_speed_factor'), params.speedFactor);
		gl.uniform1f(gl.getUniformLocation(this.program!, 'u_time'), this.animationTime);

		// Render full screen quad to update particles
		gl.bindBuffer(gl.ARRAY_BUFFER, this.backgroundVertexBuffer!);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.backgroundIndexBuffer!);

		const positionLoc = gl.getAttribLocation(this.program!, 'a_position');
		gl.enableVertexAttribArray(positionLoc);
		gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 16, 0);

		gl.drawElements(gl.TRIANGLES, this.backgroundVertexCount, gl.UNSIGNED_SHORT, 0);
		gl.disableVertexAttribArray(positionLoc);

		// Swap particle textures
		const temp = this.particleStateTexture;
		this.particleStateTexture = this.particleNextStateTexture;
		this.particleNextStateTexture = temp;

		// Restore main framebuffer
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		const canvas = gl.canvas as HTMLCanvasElement;
		gl.viewport(0, 0, canvas.width, canvas.height);

		// Re-enable blending for the render pass
		gl.enable(gl.BLEND);
	}

	private renderParticles(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
		const renderProgram = this.getRenderProgram(gl);
		gl.useProgram(renderProgram);

		// Set up matrix
		const matrixLoc = gl.getUniformLocation(renderProgram, 'u_matrix');
		gl.uniformMatrix4fv(
			matrixLoc,
			false,
			new Float32Array(options.defaultProjectionData.mainMatrix)
		);

		// Set bounds
		const bounds = this.getBounds();
		gl.uniform4f(
			gl.getUniformLocation(renderProgram, 'u_bounds'),
			bounds[0],
			bounds[1],
			bounds[2],
			bounds[3]
		);

		// Bind particle state texture
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.particleStateTexture!);
		gl.uniform1i(gl.getUniformLocation(renderProgram, 'u_particles'), 0);

		// Enable blending
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

		// Render particles as points
		gl.bindBuffer(gl.ARRAY_BUFFER, this.particleVertexBuffer!);

		const texCoordLoc = gl.getAttribLocation(renderProgram, 'a_texCoord');
		gl.enableVertexAttribArray(texCoordLoc);
		gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 8, 0);

		gl.drawArrays(gl.POINTS, 0, this.numParticles);
		gl.disableVertexAttribArray(texCoordLoc);
	}

	private renderProgram: WebGLProgram | undefined;

	private getRenderProgram(gl: WebGL2RenderingContext): WebGLProgram {
		if (!this.renderProgram) {
			const vertexShader = this.createShader(gl, gl.VERTEX_SHADER, this.getRenderVertexShader());
			const fragmentShader = this.createShader(
				gl,
				gl.FRAGMENT_SHADER,
				this.getRenderFragmentShader()
			);

			this.renderProgram = gl.createProgram()!;
			gl.attachShader(this.renderProgram, vertexShader);
			gl.attachShader(this.renderProgram, fragmentShader);
			gl.linkProgram(this.renderProgram);

			if (!gl.getProgramParameter(this.renderProgram, gl.LINK_STATUS)) {
				console.error('Render program link error:', gl.getProgramInfoLog(this.renderProgram));
			}
		}
		return this.renderProgram;
	}

	onRemove(_map: Map, gl: WebGLRenderingContext): void {
		if (this.program) gl.deleteProgram(this.program);
		if (this.renderProgram) gl.deleteProgram(this.renderProgram);
		if (this.backgroundVertexBuffer) gl.deleteBuffer(this.backgroundVertexBuffer);
		if (this.backgroundIndexBuffer) gl.deleteBuffer(this.backgroundIndexBuffer);
		if (this.particleVertexBuffer) gl.deleteBuffer(this.particleVertexBuffer);
		if (this.windUTexture) gl.deleteTexture(this.windUTexture);
		if (this.windVTexture) gl.deleteTexture(this.windVTexture);
		if (this.particleStateTexture) gl.deleteTexture(this.particleStateTexture);
		if (this.particleNextStateTexture) gl.deleteTexture(this.particleNextStateTexture);
		if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
	}

	private createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
		const shader = gl.createShader(type)!;
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			console.error('Shader compile error:', gl.getShaderInfoLog(shader));
		}
		return shader;
	}

	private getUpdateVertexShader(): string {
		return `
			attribute vec2 a_position;
			varying vec2 v_texCoord;

			void main() {
				v_texCoord = a_position;
				gl_Position = vec4(2.0 * a_position - 1.0, 0.0, 1.0);
			}
		`;
	}

	private getUpdateFragmentShader(): string {
		return `
        precision highp float;

        uniform sampler2D u_particles;
        uniform sampler2D u_wind_u;
        uniform sampler2D u_wind_v;
        uniform vec4 u_bounds; // [minLon, minLat, maxLon, maxLat]
        uniform float u_speed_factor;
        uniform float u_drop_rate;
        uniform float u_time;

        varying vec2 v_texCoord;

        // Random function
        float random(vec2 st) {
            return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
        }

        void main() {
            vec4 particle = texture2D(u_particles, v_texCoord);
            vec2 pos = particle.xy;
            float age = particle.z;
            float life = particle.w;

            // Sample wind at current position (which is also the texture coord for wind)
            float windU = texture2D(u_wind_u, pos).r;
            float windV = texture2D(u_wind_v, pos).r;
            vec2 wind_vel = vec2(windU, windV);

            // --- Correct Velocity Scaling ---
            // The velocity needs to be scaled from m/s to normalized coordinates per frame.
            // This is an approximation that works well for visualization.
            const float delta_t = 0.016; // Assume ~60fps
            vec2 grid_span = u_bounds.zw - u_bounds.xy; // [lonSpan, latSpan]
            vec2 normalized_vel = wind_vel / grid_span * u_speed_factor * delta_t;

            // The velocity in the latitude direction needs to be flipped because texture V-coordinates
            // go from 0 (top) to 1 (bottom), opposite of latitude.
            normalized_vel.y *= -1.0;

            pos += normalized_vel;

            // Age the particle
            age += 1.0;

            // --- Improved Particle Reset Logic ---
            // Reset particle if it's too old, has gone off the map, or randomly.
            bool needs_reset = false;
            if (age > life) needs_reset = true;
            if (pos.y < 0.0 || pos.y > 1.0) needs_reset = true; // Gone off top/bottom
            if (random(pos + u_time) < u_drop_rate) needs_reset = true;

            // Wrap longitude
            pos.x = fract(pos.x);

            if (needs_reset) {
                // Respawn particle at a new random location
                pos = vec2(random(v_texCoord + u_time), random(v_texCoord + u_time + 1.0));
                age = 0.0;
            }

            gl_FragColor = vec4(pos, age, life);
        }
    `;
	}

	private getRenderVertexShader(): string {
		return `
        attribute vec2 a_texCoord;
        uniform sampler2D u_particles;
        uniform mat4 u_matrix;
        uniform vec4 u_bounds;

        varying float v_age;

        void main() {
            vec4 particle = texture2D(u_particles, a_texCoord);
            vec2 pos = particle.xy;
            v_age = particle.z / particle.w;

            // Convert normalized position to lat/lon
            float lon = mix(u_bounds.x, u_bounds.z, pos.x);
            float lat = mix(u_bounds.y, u_bounds.w, pos.y);

            // Convert to Mercator coordinates
            float mercatorX = lon / 360.0 + 0.5;
            float latRad = lat * 3.14159265359 / 180.0;
            float mercatorY = 0.5 - log(tan(3.14159265359 / 4.0 + latRad / 2.0)) / (2.0 * 3.14159265359);

            gl_Position = u_matrix * vec4(mercatorX, mercatorY, 0.0, 1.0);

            gl_PointSize = 5.0; // Start here, increase if needed
        }
    `;
	}

	private getRenderFragmentShader(): string {
		return `
			precision mediump float;
			varying float v_age;

			void main() {
				float alpha = 1.0 - v_age;
				alpha = alpha * alpha; // Square for more dramatic fade
				gl_FragColor = vec4(1.0, 1.0, 1.0, alpha * 0.8);
			}
		`;
	}
}
