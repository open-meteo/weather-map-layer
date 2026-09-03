/**
 * Rasterises the resolved clipping polygons into an alpha mask for the GPU
 * path, mirroring the CPU worker's canvas clip (clipRasterToPolygons): all
 * rings in one path, filled with the configured fill rule. The mask lives in
 * mercator [0..1] space over the clip bounds; the fragment shader multiplies
 * its alpha into the output.
 */
import type { ResolvedClippingOptions } from '../utils/clipping';
import { sharedPolygonsRing, sharedPolygonsRingCount } from '../utils/clipping';
import { lat2tile, lon2tile } from '../utils/math';

export interface GpuClipMaskSource {
	canvas: OffscreenCanvas;
	/** (x0, y0, 1/w, 1/h) of the mask rectangle in mercator [0..1] space. */
	rect: [number, number, number, number];
}

/** Longest mask side in pixels; bounds the mask's VRAM cost (~16 MB RGBA max). */
const MASK_MAX_PX = 2048;
/** Padding so the polygon edge never touches the clamped texture border. */
const PAD_PX = 2;

export const rasterizeClipMask = (
	clipping: ResolvedClippingOptions
): GpuClipMaskSource | undefined => {
	const sp = clipping.polygons;
	const bounds = clipping.bounds;
	if (!sp || !bounds || sharedPolygonsRingCount(sp) === 0) return undefined;

	const [west, south, east, north] = bounds;
	const x0 = lon2tile(west, 0);
	let x1 = lon2tile(east, 0);
	if (x1 <= x0) x1 += 1; // dateline-crossing bounds continue past the world edge
	const y0 = lat2tile(north, 0);
	const y1 = lat2tile(south, 0);
	const w = x1 - x0;
	const h = y1 - y0;
	if (!(w > 0) || !(h > 0)) return undefined;

	const scale = MASK_MAX_PX / Math.max(w, h);
	const innerW = Math.max(1, Math.round(w * scale));
	const innerH = Math.max(1, Math.round(h * scale));
	const canvas = new OffscreenCanvas(innerW + 2 * PAD_PX, innerH + 2 * PAD_PX);
	const context = canvas.getContext('2d');
	if (!context) return undefined;

	// Mercator rectangle including the padding, as the shader's lookup rect.
	const padX = PAD_PX / (innerW / w);
	const padY = PAD_PX / (innerH / h);
	const rectX0 = x0 - padX;
	const rectY0 = y0 - padY;
	const rectW = w + 2 * padX;
	const rectH = h + 2 * padY;

	context.fillStyle = '#fff';
	context.beginPath();
	const numRings = sharedPolygonsRingCount(sp);
	for (let r = 0; r < numRings; r++) {
		const ring = sharedPolygonsRing(sp, r);
		for (let i = 0; i < ring.length; i++) {
			const [lon, lat] = ring[i];
			// Wrap each vertex into the mask's continuous x range.
			let mx = lon2tile(lon, 0);
			if (mx < x0 - 0.5) mx += 1;
			const px = ((mx - rectX0) / rectW) * canvas.width;
			const py = ((lat2tile(lat, 0) - rectY0) / rectH) * canvas.height;
			if (i === 0) {
				context.moveTo(px, py);
			} else {
				context.lineTo(px, py);
			}
		}
		context.closePath();
	}
	context.fill(clipping.fillRule);

	return { canvas, rect: [rectX0, rectY0, 1 / rectW, 1 / rectH] };
};
