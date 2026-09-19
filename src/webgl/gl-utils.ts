export const createShader = (
	gl: WebGLRenderingContext | WebGL2RenderingContext,
	type: number,
	source: string
): WebGLShader => {
	const shader = gl.createShader(type);
	if (!shader) throw new Error('Unable to create a WebGL shader.');
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		const message = gl.getShaderInfoLog(shader) ?? 'Unknown shader compilation error';
		gl.deleteShader(shader);
		throw new Error(message);
	}
	return shader;
};

export const createProgram = (
	gl: WebGLRenderingContext | WebGL2RenderingContext,
	vertexSource: string,
	fragmentSource: string
): WebGLProgram => {
	const vertex = createShader(gl, gl.VERTEX_SHADER, vertexSource);
	const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
	const program = gl.createProgram();
	if (!program) throw new Error('Unable to create a WebGL program.');
	gl.attachShader(program, vertex);
	gl.attachShader(program, fragment);
	gl.linkProgram(program);
	gl.deleteShader(vertex);
	gl.deleteShader(fragment);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		const message = gl.getProgramInfoLog(program) ?? 'Unknown program link error';
		gl.deleteProgram(program);
		throw new Error(message);
	}
	return program;
};

export const requireWebGL2 = (
	gl: WebGLRenderingContext | WebGL2RenderingContext
): WebGL2RenderingContext => {
	if (!('drawArraysInstanced' in gl) || !('texStorage2D' in gl)) {
		throw new Error('WebGL weather layers require a WebGL2 rendering context.');
	}
	return gl as WebGL2RenderingContext;
};

export const textureSizeSupported = (
	gl: WebGLRenderingContext | WebGL2RenderingContext,
	width: number,
	height: number
): boolean => {
	const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
	return width <= limit && height <= limit;
};

export const createRampTexture = (
	gl: WebGLRenderingContext | WebGL2RenderingContext,
	bytes: Uint8Array
): WebGLTexture => {
	const texture = gl.createTexture();
	if (!texture) throw new Error('Unable to create a color-ramp texture.');
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texImage2D(
		gl.TEXTURE_2D,
		0,
		gl.RGBA,
		bytes.length / 4,
		1,
		0,
		gl.RGBA,
		gl.UNSIGNED_BYTE,
		bytes
	);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	return texture;
};
