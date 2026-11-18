/**
 * Small WebGL helpers shared by the raster renderer, the particle system and
 * the terrain passes: program compilation with a uniform lookup, the
 * buffer-less fullscreen triangle, and the upload of MapLibre's projection
 * prelude uniforms.
 */
import type { GpuProjectionData } from './renderer';
import type { ProjectionShaderData } from './shader-source';

export interface ProgramInfo {
	program: WebGLProgram;
	uniforms: Map<string, WebGLUniformLocation>;
}

/** Compile and link a program and enumerate its active uniforms by name. */
export const buildProgram = (
	gl: WebGL2RenderingContext,
	vertexSrc: string,
	fragmentSrc: string,
	label = 'gpu'
): ProgramInfo => {
	const compile = (type: number, source: string): WebGLShader => {
		const shader = gl.createShader(type);
		if (!shader) throw new Error(`${label}: could not create shader`);
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			const log = gl.getShaderInfoLog(shader);
			gl.deleteShader(shader);
			throw new Error(`${label}: shader compile failed: ${log}\n${source}`);
		}
		return shader;
	};

	const program = gl.createProgram();
	if (!program) throw new Error(`${label}: could not create program`);
	gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSrc));
	gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSrc));
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		const log = gl.getProgramInfoLog(program);
		gl.deleteProgram(program);
		throw new Error(`${label}: program link failed: ${log}`);
	}

	const uniforms = new Map<string, WebGLUniformLocation>();
	const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
	for (let i = 0; i < count; i++) {
		const active = gl.getActiveUniform(program, i);
		if (!active) continue;
		const location = gl.getUniformLocation(program, active.name);
		if (location) uniforms.set(active.name.replace(/\[0\]$/, ''), location);
	}
	return { program, uniforms };
};

/** Fullscreen triangle via gl_VertexID; no buffers, works with an empty VAO. */
export const FULLSCREEN_VERTEX = `#version 300 es
out vec2 v_uv;
void main() {
	vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	v_uv = p;
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Upload the projection prelude's uniforms from the map's projection data. */
export const uploadProjectionUniforms = (
	gl: WebGL2RenderingContext,
	u: (name: string) => WebGLUniformLocation | null,
	data: GpuProjectionData
): void => {
	gl.uniformMatrix4fv(u('u_projection_matrix'), false, data.mainMatrix as Float32List);
	gl.uniformMatrix4fv(u('u_projection_fallback_matrix'), false, data.fallbackMatrix as Float32List);
	gl.uniform4f(u('u_projection_tile_mercator_coords'), ...data.tileMercatorCoords);
	gl.uniform4f(u('u_projection_clipping_plane'), ...data.clippingPlane);
	gl.uniform1f(u('u_projection_transition'), data.projectionTransition);
};

/** Program and VAO cache identity: projection variant plus terrain. */
export const variantKey = (shaderData: ProjectionShaderData, elevated: boolean): string =>
	`${shaderData.variantName}${elevated ? '|elev' : ''}`;
