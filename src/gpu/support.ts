/**
 * What the GPU layer can do in this browser, probed once on a throwaway
 * WebGL2 context: a host decides up front whether to render with
 * WeatherGpuLayer at all and which of its passes to use.
 */

export interface GpuSupport {
	/** A WebGL2 context could be created (MapLibre 6 needs one for any rendering). */
	webgl2: boolean;
	/**
	 * Float render targets (EXT_color_buffer_float): without them the particle
	 * pass and terrain draping stay off while rasters, arrows and contours draw.
	 */
	particles: boolean;
	/**
	 * Rendering runs on the CPU (SwiftShader, llvmpipe, WARP, or the browser
	 * flags a major performance caveat): every pixel of the per-pixel field
	 * shader is CPU work there, so tile rasters are the cheaper path.
	 */
	software: boolean;
	maxTextureSize: number;
	/** GL renderer string, for diagnostics. */
	renderer?: string;
}

const SOFTWARE_RENDERER =
	/swiftshader|llvmpipe|softpipe|software rasterizer|software renderer|basic render driver|\bwarp\b/i;

let cached: GpuSupport | undefined;

/** Probe the WebGL2 capabilities the GPU layer depends on (cached after the first call). */
export const detectGpuSupport = (): GpuSupport => {
	if (cached) return cached;
	const none: GpuSupport = { webgl2: false, particles: false, software: false, maxTextureSize: 0 };
	if (typeof document === 'undefined') return none;

	const canvas = document.createElement('canvas');
	let gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true });
	let caveat = false;
	if (!gl) {
		gl = canvas.getContext('webgl2');
		caveat = gl !== null;
	}
	if (!gl) return (cached = none);

	// Firefox reports the (sanitised) renderer directly and deprecates the debug
	// extension; Chrome and Safari answer a generic "WebKit WebGL" without it.
	let renderer = gl.getParameter(gl.RENDERER) as string;
	if (/webkit webgl/i.test(renderer)) {
		const debug = gl.getExtension('WEBGL_debug_renderer_info');
		if (debug) renderer = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string;
	}

	cached = {
		webgl2: true,
		particles: gl.getExtension('EXT_color_buffer_float') !== null,
		software: caveat || SOFTWARE_RENDERER.test(renderer),
		maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
		renderer
	};
	// Browsers cap live contexts per page; free this one right away.
	gl.getExtension('WEBGL_lose_context')?.loseContext();
	return cached;
};
