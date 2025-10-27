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

	private hardcodedColorScale = [
		{ value: -20, color: [0, 0, 255, 255] },
		{ value: 0, color: [0, 255, 255, 255] },
		{ value: 20, color: [0, 255, 0, 255] },
		{ value: 40, color: [255, 255, 0, 255] },
		{ value: 60, color: [255, 0, 0, 255] }
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

		// Vertex shader - simple fullscreen quad
		const vertexShader = this.createShader(
			gl,
			gl.VERTEX_SHADER,
			`
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      uniform mat4 u_matrix;
      varying vec2 v_texCoord;

      void main() {
        gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `
		);

		// Fragment shader with color ramp
		const fragmentShader = this.createShader(
			gl,
			gl.FRAGMENT_SHADER,
			`
					precision mediump float;
					uniform sampler2D u_data_texture;
					uniform sampler2D u_color_ramp;
					varying vec2 v_texCoord;

					void main() {
  					float normalized = texture2D(u_data_texture, v_texCoord).r;
            float opacity = 0.5;

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

		// Create buffer - we'll populate it with actual coordinates later
		this.buffer = gl.createBuffer()!;
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
		const minVal = this.hardcodedColorScale[0].value;
		const maxVal = this.hardcodedColorScale[this.hardcodedColorScale.length - 1].value;

		const normalizedData = new Float32Array(nx * ny);
		for (let i = 0; i < data.values.length; i++) {
			normalizedData[i] = Math.max(0, Math.min(1, (data.values[i] - minVal) / (maxVal - minVal)));
		}
		// Create data texture
		this.dataTexture = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, nx, ny, 0, gl.RED, gl.FLOAT, normalizedData);

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
		if (!this.program || !this.dataLoaded || !this.buffer) {
			return;
		}

		const grid = this.domain.grid;

		const minLon = grid.lonMin;
		const maxLon = grid.lonMin + (grid.nx - 1) * grid.dx;
		let minLat = grid.latMin;
		let maxLat = grid.latMin + (grid.ny - 1) * grid.dy;

		// Clamp latitudes to Mercator-safe range
		const MERCATOR_MAX_LAT = 85.0511;
		minLat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, minLat));
		maxLat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, maxLat));

		console.log('minLon', minLon, 'maxLon', maxLon, 'minLat', minLat, 'maxLat', maxLat);

		const sw = MercatorCoordinate.fromLngLat([minLon, minLat]);
		const ne = MercatorCoordinate.fromLngLat([maxLon, maxLat]);

		console.log('projected', sw, ne);

		// Create vertices with position and texture coordinates
		const vertices = new Float32Array([
			// Position (Mercator)    // TexCoord
			sw.x,
			sw.y,
			0,
			0, // bottom-left
			ne.x,
			sw.y,
			1,
			0, // bottom-right
			sw.x,
			ne.y,
			0,
			1, // top-left
			ne.x,
			ne.y,
			1,
			1 // top-right
		]);

		gl.useProgram(this.program);

		// Update buffer with new vertices
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
		gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);

		const matrixLoc = gl.getUniformLocation(this.program, 'u_matrix');
		gl.uniformMatrix4fv(
			matrixLoc,
			false,
			new Float32Array(options.defaultProjectionData.mainMatrix)
		);

		// Set up position attribute (2 floats for position)
		const positionLoc = gl.getAttribLocation(this.program, 'a_position');
		gl.enableVertexAttribArray(positionLoc);
		gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 16, 0); // stride=16, offset=0

		// Set up texture coordinate attribute (2 floats for texcoord)
		const texCoordLoc = gl.getAttribLocation(this.program, 'a_texCoord');
		gl.enableVertexAttribArray(texCoordLoc);
		gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 16, 8); // stride=16, offset=8

		// Bind textures
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.dataTexture!);
		gl.uniform1i(gl.getUniformLocation(this.program, 'u_data_texture'), 0);

		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.colorRampTexture!);
		gl.uniform1i(gl.getUniformLocation(this.program, 'u_color_ramp'), 1);

		// Draw
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

		// Clean up
		gl.disableVertexAttribArray(positionLoc);
		gl.disableVertexAttribArray(texCoordLoc);
	}

	onRemove(_map: Map, gl: WebGLRenderingContext): void {
		if (this.program) gl.deleteProgram(this.program);
		if (this.buffer) gl.deleteBuffer(this.buffer);
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
