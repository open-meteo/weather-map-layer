/**
 * Path A: renders raster tiles on the GPU behind the existing tile pipeline.
 *
 * The per-tile "camera" is an ortho matrix over the tile's mercator box, so
 * this shares the entire shader/uniform machinery with the custom layer; the
 * only difference is the framebuffer: an OffscreenCanvas whose content is
 * transferred to an ImageBitmap, exactly what the CPU worker produces.
 */
import type { ResolvedClippingOptions } from '../utils/clipping';
import { halfQuantum as computeHalfQuantum } from '../utils/math';

import { computeGridUniforms } from './grid-uniforms';
import { WeatherGpuRenderer, mercatorBoxMatrix } from './renderer';

import type { Data, DimensionRange, Domain, RenderOptions, TileIndex } from '../types';

export interface GpuTileRequest {
	tileIndex: TileIndex;
	data: Data;
	ranges: DimensionRange[];
	domain: Domain;
	renderOptions: RenderOptions;
	clippingOptions?: ResolvedClippingOptions;
}

export class GpuTileRenderer {
	private canvas: OffscreenCanvas;
	private gl: WebGL2RenderingContext;
	private renderer: WeatherGpuRenderer;

	constructor() {
		this.canvas = new OffscreenCanvas(1, 1);
		const gl = this.canvas.getContext('webgl2', {
			// The shader outputs premultiplied alpha (like every canvas compositor
			// expects); no depth/stencil needed for a full-tile quad.
			premultipliedAlpha: true,
			alpha: true,
			depth: false,
			stencil: false,
			antialias: false
		});
		if (!gl) {
			throw new Error('gpu: could not create a WebGL2 context');
		}
		this.gl = gl;
		this.renderer = new WeatherGpuRenderer(gl);
	}

	renderTile(request: GpuTileRequest): ImageBitmap {
		const { z, x, y } = request.tileIndex;
		const tileSize = request.renderOptions.tileSize;
		const values = request.data.values;
		if (!values) {
			throw new Error('gpu: no values provided');
		}

		const gl = this.gl;
		if (this.canvas.width !== tileSize || this.canvas.height !== tileSize) {
			this.canvas.width = tileSize;
			this.canvas.height = tileSize;
		}

		const gridUniforms = computeGridUniforms(request.domain.grid, request.ranges);

		gl.viewport(0, 0, tileSize, tileSize);
		gl.disable(gl.BLEND); // opaque write of premultiplied colours into the tile
		gl.disable(gl.DEPTH_TEST);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);

		// Tile (z, x, y) covers mercator x in [x, x+1]/2^z, y in [y, y+1]/2^z.
		const worldTiles = Math.pow(2, z);
		const matrix = mercatorBoxMatrix(
			x / worldTiles,
			y / worldTiles,
			(x + 1) / worldTiles,
			(y + 1) / worldTiles
		);

		this.renderer.draw({
			matrix,
			layers: [
				{
					gridUniforms,
					valuesTexture: this.renderer.getValueTexture(values, gridUniforms.nx, gridUniforms.ny)
				}
			],
			interpolation: request.renderOptions.interpolation,
			lut: this.renderer.getLut(request.renderOptions.colorScale, request.renderOptions.colorBlend),
			halfQuantum: computeHalfQuantum(request.data.scaleFactor),
			opacity: 1,
			clipBounds: request.clippingOptions?.bounds
		});

		return this.canvas.transferToImageBitmap();
	}

	dispose(): void {
		this.renderer.dispose();
	}
}

let sharedRenderer: GpuTileRenderer | undefined;

/** Lazily created shared renderer: one GL context renders all protocol tiles. */
export const getSharedTileRenderer = (): GpuTileRenderer => {
	if (!sharedRenderer) {
		sharedRenderer = new GpuTileRenderer();
	}
	return sharedRenderer;
};
