import { Map, CustomRenderMethodInput, CustomLayerInterface } from 'maplibre-gl';
import { OMapsFileReader } from './om-file-reader';
import { Domain, Variable } from './types';
import { MercatorCoordinate } from 'maplibre-gl';

export class WebGLRasterLayer implements CustomLayerInterface {
	id: string;
	type: 'custom' = 'custom';
	renderingMode: '2d' = '2d';

	private map: Map | undefined;
	private gl: WebGL2RenderingContext | undefined;
	private program: WebGLProgram | undefined;
	private dataTexture: WebGLTexture | undefined;
	private colorRampTexture: WebGLTexture | undefined;
	private buffer: WebGLBuffer | undefined;

	private omUrl: string;
	private omFileReader: OMapsFileReader;
	private domain: Domain;
	private variable: Variable;
	private dataLoaded = false;
	private meshResolution = 50; // Adjustable resolution
	private indexBuffer: WebGLBuffer | undefined;
	private vertexCount = 0;

	private createMeshVertices(resolution: number): Float32Array {
		const vertices: number[] = [];

		// Create a grid of vertices
		for (let y = 0; y <= resolution; y++) {
			for (let x = 0; x <= resolution; x++) {
				const u = x / resolution; // 0 to 1
				const v = y / resolution; // 0 to 1

				// Position will be calculated from bounds in render()
				// For now, store normalized coordinates
				vertices.push(
					u,
					v, // a_position (will be transformed to Mercator)
					u,
					v // a_texCoord (for texture sampling)
				);
			}
		}

		return new Float32Array(vertices);
	}

	private createMeshIndices(resolution: number): Uint16Array {
		const indices: number[] = [];

		// Create triangle strip indices for the mesh
		for (let y = 0; y < resolution; y++) {
			for (let x = 0; x < resolution; x++) {
				const topLeft = y * (resolution + 1) + x;
				const topRight = topLeft + 1;
				const bottomLeft = (y + 1) * (resolution + 1) + x;
				const bottomRight = bottomLeft + 1;

				// Two triangles per quad
				indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
			}
		}

		this.vertexCount = indices.length;
		return new Uint16Array(indices);
	}
	private hardcodedColorScale = [
		{ value: -35, color: [75, 0, 130, 255] }, // Deep Purple
		{ value: -30, color: [128, 0, 128, 255] }, // Purple
		{ value: -20, color: [75, 0, 130, 255] }, // Indigo
		{ value: -15, color: [0, 0, 255, 255] }, // Blue
		{ value: -10, color: [0, 128, 255, 255] }, // Light Blue
		{ value: -5, color: [0, 255, 255, 255] }, // Cyan
		{ value: 0, color: [0, 255, 128, 255] }, // Aqua-Green
		{ value: 10, color: [0, 255, 0, 255] }, // Green
		{ value: 20, color: [128, 255, 0, 255] }, // Yellow-Green
		{ value: 30, color: [255, 255, 0, 255] }, // Yellow
		{ value: 40, color: [255, 0, 0, 255] }, // Red
		{ value: 45, color: [255, 64, 0, 255] }, // Deep Orange
		{ value: 50, color: [255, 128, 0, 255] }, // Orange-Red
		{ value: 55, color: [255, 165, 0, 255] }, // Orange
		{ value: 60, color: [255, 0, 0, 255] } // Red
	];

	constructor(id: string, omUrl: string, domain: Domain, variable: Variable) {
		this.id = id;
		this.domain = domain;
		this.variable = variable;
		this.omUrl = omUrl;
		this.omFileReader = new OMapsFileReader(domain, false, false);
	}

	async onAdd(map: Map, gl: WebGL2RenderingContext): Promise<void> {
		this.gl = gl;
		this.map = map;

		const vertexShader = this.createShader(
			gl,
			gl.VERTEX_SHADER,
			`
			attribute vec2 a_position; // Normalized coordinates (0-1)
      attribute vec2 a_texCoord; // Texture coordinates (0-1)
      uniform mat4 u_matrix;
      uniform vec4 u_bounds; // [minLon, minLat, maxLon, maxLat]
      varying vec2 v_texCoord;

      // Convert latitude to Web Mercator Y coordinate
      float latToMercatorY(float lat) {
          float rad = lat * 3.14159265359 / 180.0;
          return log(tan(3.14159265359 / 4.0 + rad / 2.0));
      }

      // Convert Web Mercator Y back to latitude
      float mercatorYToLat(float y) {
          return atan(exp(y)) * 2.0 - 3.14159265359 / 2.0;
      }

      void main() {
          // Convert normalized position to actual lat/lon
          float lon = mix(u_bounds.x, u_bounds.z, a_position.x);
          float lat = mix(u_bounds.y, u_bounds.w, a_position.y);

          // Convert to Mercator coordinates for positioning
          float mercatorX = lon / 360.0 + 0.5; // Simple longitude to X
          float latRad = lat * 3.14159265359 / 180.0;
          float mercatorY = 0.5 - log(tan(3.14159265359 / 4.0 + latRad / 2.0)) / (2.0 * 3.14159265359);

          // Set position
          gl_Position = u_matrix * vec4(mercatorX, mercatorY, 0.0, 1.0);

          // For texture sampling, we need to account for the regular lat/lon grid
          // The texture coordinates remain as-is since our data is in regular lat/lon grid
          v_texCoord = a_texCoord;
      }
    `
		);

		const fragmentShader = this.createShader(
			gl,
			gl.FRAGMENT_SHADER,
			`
					precision mediump float;
					uniform sampler2D u_data_texture;
					uniform sampler2D u_color_ramp;
					uniform vec2 u_value_range; // [minValue, maxValue] from color scale
					varying vec2 v_texCoord;

					void main() {
  					// Get the absolute value from the texture
            float absoluteValue = texture2D(u_data_texture, v_texCoord).r;
            float opacity = 0.75;

            // Normalize the absolute value to 0-1 range for color lookup
            float normalized = clamp((absoluteValue - u_value_range.x) / (u_value_range.y - u_value_range.x), 0.0, 1.0);

						// Lookup color from ramp
						vec4 color = texture2D(u_color_ramp, vec2(normalized, 0.5));
						color.a *= opacity;
						gl_FragColor = color;
					}
				`
		);

		this.program = gl.createProgram()!;
		gl.attachShader(this.program, vertexShader);
		gl.attachShader(this.program, fragmentShader);
		gl.linkProgram(this.program);

		if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
			console.error('Program link error:', gl.getProgramInfoLog(this.program));
		}

		// Create mesh buffers
		this.buffer = gl.createBuffer()!;
		this.indexBuffer = gl.createBuffer()!;

		// Generate mesh data
		const vertices = this.createMeshVertices(this.meshResolution);
		const indices = this.createMeshIndices(this.meshResolution);

		// Upload vertex data
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

		// Upload index data
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

		// Create color ramp texture
		this.colorRampTexture = this.createColorRampTexture(gl);

		// Load data asynchronously
		await this.omFileReader.init(this.omUrl);
		await this.loadData(map);
	}

	private async loadData(map: Map): Promise<void> {
		console.log('Loading data...');
		const data = await this.omFileReader.readVariable(this.variable, [
			{ start: 0, end: this.domain.grid.ny },
			{ start: 0, end: this.domain.grid.nx }
		]);
		if (!this.gl || !data.values) return;

		const { nx, ny } = this.domain.grid;
		console.log('Data loaded:', { nx, ny, dataLength: data.values.length });
		console.log('Data range: ', data.values.slice(0, 10));

		const gl = this.gl;

		// Create data texture
		this.dataTexture = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, nx, ny, 0, gl.RED, gl.FLOAT, data.values);

		// Check for GL errors
		let error = gl.getError();
		if (error !== gl.NO_ERROR) {
			console.error('WebGL error after texture upload:', error);
		}

		this.dataLoaded = true;
		console.log('Texture uploaded, triggering repaint');
		map.triggerRepaint();
	}

	render(gl: WebGLRenderingContext, options: CustomRenderMethodInput): void {
		if (!this.program || !this.dataLoaded || !this.buffer || !this.indexBuffer) {
			return;
		}

		const grid = this.domain.grid;

		const minLat = grid.latMin;
		const maxLat = grid.latMin + grid.ny * grid.dy;
		const minLon = grid.lonMin;
		const maxLon = grid.lonMin + grid.nx * grid.dx;

		// Handle world wrapping
		const map = this.map!;
		const bounds = map.getBounds();
		const viewportWest = bounds.getWest();
		const viewportEast = bounds.getEast();

		// Determine how many world copies we need to render
		const worldCopies = [];

		// Add main world
		worldCopies.push({ lonOffset: 0, minLon, maxLon });

		// Add wrapped worlds if needed
		if (viewportWest < minLon) {
			worldCopies.push({ lonOffset: -360, minLon: minLon - 360, maxLon: maxLon - 360 });
		}
		if (viewportEast > maxLon) {
			worldCopies.push({ lonOffset: 360, minLon: minLon + 360, maxLon: maxLon + 360 });
		}

		gl.useProgram(this.program);

		// Set up buffers
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

		// Set up attributes
		const positionLoc = gl.getAttribLocation(this.program, 'a_position');
		gl.enableVertexAttribArray(positionLoc);
		gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 16, 0);

		const texCoordLoc = gl.getAttribLocation(this.program, 'a_texCoord');
		gl.enableVertexAttribArray(texCoordLoc);
		gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 16, 8);

		// Set matrix uniform
		const matrixLoc = gl.getUniformLocation(this.program, 'u_matrix');
		gl.uniformMatrix4fv(
			matrixLoc,
			false,
			new Float32Array(options.defaultProjectionData.mainMatrix)
		);

		const valueRangeLoc = gl.getUniformLocation(this.program, 'u_value_range');
		const minVal = this.hardcodedColorScale[0].value;
		const maxVal = this.hardcodedColorScale[this.hardcodedColorScale.length - 1].value;
		gl.uniform2f(valueRangeLoc, minVal, maxVal);

		// Bind textures
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.dataTexture!);
		gl.uniform1i(gl.getUniformLocation(this.program, 'u_data_texture'), 0);

		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.colorRampTexture!);
		gl.uniform1i(gl.getUniformLocation(this.program, 'u_color_ramp'), 1);

		// Enable blending
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

		// Render each world copy
		const boundsLoc = gl.getUniformLocation(this.program, 'u_bounds');

		for (const world of worldCopies) {
			// Set bounds for this world copy
			gl.uniform4f(boundsLoc, world.minLon, minLat, world.maxLon, maxLat);

			// Draw the mesh
			gl.drawElements(gl.TRIANGLES, this.vertexCount, gl.UNSIGNED_SHORT, 0);
		}

		// Clean up
		gl.disableVertexAttribArray(positionLoc);
		gl.disableVertexAttribArray(texCoordLoc);
	}

	onRemove(_map: Map, gl: WebGLRenderingContext): void {
		if (this.program) gl.deleteProgram(this.program);
		if (this.buffer) gl.deleteBuffer(this.buffer);
		if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
		if (this.dataTexture) gl.deleteTexture(this.dataTexture);
		if (this.colorRampTexture) gl.deleteTexture(this.colorRampTexture);
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

	private createColorRampTexture(gl: WebGLRenderingContext): WebGLTexture {
		const texture = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, texture);

		const width = 256;
		const rampData = new Uint8Array(width * 4);
		const scale = this.hardcodedColorScale;
		const minVal = scale[0].value;
		const maxVal = scale[scale.length - 1].value;

		for (let i = 0; i < width; i++) {
			const currentValue = minVal + (i / (width - 1)) * (maxVal - minVal);

			let startStop = scale[0];
			let endStop = scale[scale.length - 1];
			for (let j = 0; j < scale.length - 1; j++) {
				if (currentValue >= scale[j].value && currentValue <= scale[j + 1].value) {
					startStop = scale[j];
					endStop = scale[j + 1];
					break;
				}
			}

			const range = endStop.value - startStop.value;
			const t = range === 0 ? 0 : (currentValue - startStop.value) / range;

			const idx = i * 4;
			for (let c = 0; c < 4; c++) {
				rampData[idx + c] = startStop.color[c] + t * (endStop.color[c] - startStop.color[c]);
			}
		}

		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rampData);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

		return texture;
	}
}
