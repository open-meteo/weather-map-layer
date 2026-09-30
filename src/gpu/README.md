# GPU custom layer (experimental)

`WeatherGpuLayer` draws one scalar variable of one regular lat/lon grid on the
GPU as a MapLibre `CustomLayerInterface`. It sits next to the CPU tile pipeline
(nothing outside `src/gpu/` changes) and reuses its renderer-agnostic pieces:

| Reused as-is                       | From                                                  |
| ---------------------------------- | ----------------------------------------------------- |
| om:// URL grammar + render options | `utils/parse-request.ts`, `parse-url.ts`              |
| Data loading, state cache, reader  | `om-protocol-state.ts`, `om-file-reader.ts`           |
| Grid definition + bounds/ranges    | `types.ts` (`GridData`), `grids/regular.ts`           |
| Colour scale semantics             | `utils/styling.ts` (`makeColorSampler` bakes the LUT) |

Only the rasterization step (per-pixel grid lookup, interpolation and colour
mapping) has a GPU twin: GLSL ports in `shader-source.ts` that mirror
`grids/regular.ts` and `grids/interpolations.ts` 1:1.

## Data flow

1. `layer.setUrl(omUrl)` normalizes the URL (`latest.json` forms included) and
   parses it with the protocol settings, like a tile request would.
2. `data.ts` loads the variable through the shared protocol state, so a GPU
   layer and a CPU raster source on the same URL share one fetch and one
   `Float32Array`.
3. `grid-uniforms.ts` derives the sampler uniforms (origin, step, size, wrap
   flags) and the grid's mercator quad from the `GridData` and the loaded
   dimension ranges, using the CPU `RegularGrid` for the bounds.
4. `renderer.ts` uploads the values as an `R32F` texture (NaN becomes a large
   finite sentinel; float-texture NaN handling is driver dependent), cached by
   array identity under an LRU byte budget shared by all layers on the map.

## Colour mapping

`color-lut.ts` bakes the request's colour scale into a 2048-texel RGBA8 LUT by
calling the CPU `makeColorSampler` at every texel, so the GPU inherits the CPU
colours by construction. The shader maps a value to the LUT coordinate with
`(value + halfQuantum - min) / (max - min)`; blended scales sample LINEAR,
banded ones NEAREST (band edges quantised to `range / 2048`).

## Drawing

The vertex stage is compiled around MapLibre's per-projection `shaderData`
prelude and calls its `projectTile`, so mercator, globe and the transition all
render natively. The grid's quad is a 128x128 mesh so it can curve around the
sphere; it is drawn once per visible world copy (`u_worldOffset`) on flat
mercator, once on the globe. The fragment shader turns the interpolated
mercator position back into lat/lon, locates the cell exactly like
`RegularGrid.locate()` (wrap and the ICON double-width last cell included),
interpolates with the URL's `interpolation` method and writes premultiplied
colour.

A `setUrl` with new data cross-fades: the previous frame keeps drawing
underneath at a compensated opacity while the new one fades in on top over
250 ms, so coverage never dips. Restyles that resolve to the same array (a
different `interpolation`, `color_blend` or colour scale) swap instantly.

```js
maplibregl.addProtocol('om', OMWeatherMapLayer.omProtocol); // popups etc. still work
const layer = new OMWeatherMapLayer.WeatherGpuLayer({ opacity: 0.75 });
map.addLayer(layer, 'waterway-tunnel');
await layer.setUrl('om://.../ecmwf_ifs025/latest.json?variable=temperature_2m');
```

## Deliberately not in this layer (yet)

- Projected and reduced-gaussian grids (`computeGridUniforms` throws).
- Seamless composite domains and variables with directions (wind arrows,
  barbs, particles): `setUrl` rejects them; use the CPU path.
- In-shader temporal value blending between timesteps, contour isolines,
  rectangular or polygon clipping, 3D terrain draping.
- Exact band edges for non-blended scales (an in-shader breakpoint search).
- WebGL context loss (recreate the layer).
- fp32 shader math: expect sub-pixel differences to the CPU (double) path and
  possible jitter at very high zoom.
