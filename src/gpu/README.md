# GPU render paths (experimental)

This module explores rendering the weather field on the GPU. It is fully
parallel to the CPU pipeline — nothing outside `src/gpu/` changed — and reuses
the existing renderer-agnostic pieces:

| Reused as-is                        | From                                                  |
| ----------------------------------- | ----------------------------------------------------- |
| om:// URL grammar + render options  | `utils/parse-request.ts`, `parse-url.ts`              |
| Data loading, state cache, reader   | `om-protocol-state.ts`, `om-file-reader.ts`           |
| Grid definitions + bounds/ranges    | `types.ts` (`GridData`), `grids/*` (CPU classes)      |
| Projection constants                | `grids/projections.ts` (instantiated, fields read)    |
| Colour scale semantics              | `utils/styling.ts` (`makeColorSampler` bakes the LUT) |
| Vector tiles (contours/arrows/grid) | unchanged CPU worker path                             |

Only the _rasterization step_ — per-pixel projection, interpolation and colour
mapping — has a GPU twin: GLSL ports in `shader-source.ts` that mirror
`grids/regular.ts` / `grids/projected.ts` / `grids/interpolations.ts` 1:1.

## Path B (main focus): `WeatherGpuLayer` — tile-free custom layer

A MapLibre `CustomLayerInterface` that draws the field straight into the map's
GL context. The grid values sit in an `R32F` texture; a fragment shader on a
quad over the grid's mercator bounds evaluates every visible screen pixel per
frame. No tiles, no workers, no ImageBitmaps.

```js
maplibregl.addProtocol('om', OMWeatherMapLayer.omProtocol); // popups etc. still work
const layer = new OMWeatherMapLayer.WeatherGpuLayer({ opacity: 0.75 });
map.addLayer(layer, 'waterway-tunnel');
await layer.setUrl('om://…/2025-06-06T1200.om?variable=temperature_2m');
```

What this buys over the tile pipeline:

- **Free restyling** — interpolation method, colour scale, blending and opacity
  are uniform/LUT changes; the next frame simply uses them.
- **Temporal value blending** — `setUrl` to another timestep on the same grid
  cross-fades the _data values_ in-shader (`mix(prev, next, t)`), i.e. real
  temporal interpolation rather than an alpha fade of two rendered frames.
- **No stale tiles** — zoom/pan re-evaluates every pixel each frame.
- Foundation for per-frame effects (particles/streamlines) later.

## Path A (benchmark companion): `omProtocolGpu` — GPU tile renderer

A drop-in `om://` protocol handler that keeps the whole tile pipeline but
renders each raster tile with the same shaders into an OffscreenCanvas
(`tile-renderer.ts`), instead of the CPU worker's per-pixel loop. Requests the
GPU cannot serve fall through to the original `omProtocol` unchanged: TileJSON,
vector tiles, seamless domains, gaussian grids, polygon clipping, no-WebGL2.

```js
maplibregl.addProtocol('om', OMWeatherMapLayer.omProtocolGpu);
```

Path A exists to isolate variables in benchmarking: A vs CPU measures the raw
rasterization speedup inside an identical architecture; B vs A measures what
dropping the tile/bitmap machinery is worth.

## Current scope / known gaps

- Grids: `regular`, all `projected*` types and the **reduced gaussian** grid
  (the flat value array is packed into a 2D texture; the per-row longitude
  count / index arithmetic of `grids/gaussian.ts` runs in the shader).
- **Seamless composite domains** render natively in path B as one multi-layer
  pass: per-layer sampling functions are generated into a single shader, the
  smooth-step edge weights (including the projected-grid edge distance and the
  NaN-distance refinement of `seamless-sampling.ts`) blend finest-first. Sub-
  layers load lazily per zoom level with the same viewport/lead-time gates as
  the CPU handler. Path A (parked) keeps its CPU fallback for seamless.
- **Wind arrows** (`setArrows`, gpu/arrows.ts): a hybrid pass in the same
  layer — the CPU samples speed/direction at a sparse screen lattice with the
  exact tile-worker samplers (incl. the seamless circular vector blend), the
  GPU draws one instanced arrow per anchor through `projectTile`. Each
  instance carries its previous and current state, mixed by the raster's
  temporal u_mix, so arrows rotate/grow/fade smoothly across timesteps. A
  foreshortening probe fades arrows at the globe's limb and polar
  convergence. Wind barbs are not ported (discrete glyph alphabet).
- **Wind particle animation** (`setParticles`, gpu/particles.ts): particles
  advect through the wind field and leave fading trails. Particle state lives
  in ping-pong RGBA32F textures; the update pass samples u/v component
  textures (derived on the CPU from speed + direction, cached per array) with
  the same generated grid samplers as the raster — all grid kinds and seamless
  composites work, and plain grids mix prev/current components by the raster's
  temporal u_mix. Trails accumulate in screen-space RGBA8 buffers with a
  quantised per-frame decay; on flat mercator a camera move _reprojects_ the
  history through the plane homography of the view matrix (trails follow the
  map through pan/zoom/rotate/pitch), on the globe it clears and rebuilds.
  Points draw through `projectTile`, so the animation follows the globe.
  Requires `EXT_color_buffer_float` (else the pass is a no-op).
- **prepareUrl/commit**: the load resolves to a commit callback so a host can
  prepare several layers and commit them in the same frame; `setUrl` is
  prepare + immediate commit. `drawRaster: false` gives an arrows-only layer.
- **Contour isolines** (`setContours`): `fwidth`-antialiased screen-space
  lines over the composite value in the same fragment pass — at every multiple
  of a step or at explicit levels (the URL's `intervals` / colour-scale
  breakpoints), with the CPU contour style's modulo classes (heavier ×10/×50/
  ×100 lines). They morph with the temporal blend, follow the globe and have
  no tile seams; they fade out where the grid resolution drops below ~2px per
  cell (the bilinear derivative speckles there). Labels stay on the CPU
  contour tiles.
- Clipping: bounds only; polygon clipping falls back to CPU (path A).
- **Globe projection**: path B compiles its vertex stage around MapLibre's
  per-projection `shaderData` prelude (`projectTile`), so mercator, globe and
  the transition all render natively; the quad is a 128×128 mesh so it curves
  around the sphere. Data poleward of the mercator clamp (±85.05°) leaves the
  polar caps empty on the globe.
- Banded (non-blend) colour scales sample a 2048-texel LUT with NEAREST, so
  band edges are quantised to `range/2048` — visually identical in practice,
  but an exact in-shader breakpoint search is the precise fix.
- fp32: shader math is single precision (CPU is double). Expect sub-pixel
  differences, and potential jitter at very high zoom (z ≳ 12); the standard
  fix (camera-relative coordinates) is a follow-up.
- NaN cells are encoded as a large sentinel at upload (`MISSING_SENTINEL`)
  because NaN in float textures is driver-dependent.
- WebGL context loss is not yet handled (recreate the layer / renderer).

## Benchmarks

`examples/gpu/benchmark.html` renders identical tile sets through the CPU
protocol and `omProtocolGpu`, reports ms/tile, and pixel-diffs the two outputs
for parity; it also sweeps `WeatherGpuLayer` full-viewport frame times.
