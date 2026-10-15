# GPU custom layer (experimental)

`WeatherGpuLayer` renders the weather field on the GPU, straight into the
map's WebGL2 context: no tiles, no ImageBitmaps. It shares the om:// URL
grammar, the protocol state cache and the file reader with the CPU tile path, so a GPU layer and the tile protocol pointed at the same
URL share one fetch and one in-memory copy of the data.

| Shared with the CPU path           | From                                                  |
| ---------------------------------- | ----------------------------------------------------- |
| om:// URL grammar + render options | `utils/parse-request.ts`, `parse-url.ts`              |
| Data loading, state cache, reader  | `om-protocol-state.ts`, `om-file-reader.ts`           |
| Grid definitions + bounds/ranges   | `types.ts` (`GridData`), `grids/*` (CPU classes)      |
| Projection constants               | `grids/projections.ts` (instantiated, fields read)    |
| Colour scale semantics             | `utils/styling.ts` (`makeColorSampler` bakes the LUT) |
| Point sampling for arrows          | `utils/samplers.ts` (the tile worker's samplers)      |
| Contour labels, wind barbs         | CPU vector tiles only (not ported)                    |

The per-pixel projection, interpolation and colour mapping are GLSL ports in
`shader-source.ts` that mirror `grids/regular.ts` / `grids/projected.ts` /
`grids/gaussian.ts` / `grids/interpolations.ts`.

## Usage

```js
maplibregl.addProtocol('om', OMWeatherMapLayer.omProtocol); // popups etc. still work
const layer = new OMWeatherMapLayer.WeatherGpuLayer({ opacity: 0.75 });
map.addLayer(layer, 'waterway-tunnel');
await layer.setUrl('om://…/2025-06-06T1200.om?variable=temperature_2m');
```

The grid values sit in `R32F` textures; a fragment shader on a mesh over the
grid's mercator bounds evaluates every visible screen pixel per frame. Hence:

- **Free restyling**: interpolation method, colour scale, blending and opacity
  are uniform/LUT changes; the next frame simply uses them.
- **Temporal value blending**: `setUrl` to another timestep on the same grid
  mixes the _data values_ in-shader (`mix(prev, next, t)`), real temporal
  interpolation rather than an alpha fade of two rendered frames. A variable
  or domain switch dissolves instead (opacity-compensated crossfade).
- **No stale tiles**: zoom/pan re-evaluates every pixel each frame.
- **prepareUrl/commit**: the load resolves to a commit callback so a host can
  prepare several layers and commit them in the same frame; `setUrl` is
  prepare + immediate commit. `drawRaster: false` gives an overlay-only layer.

## Features

- Grids: `regular`, all `projected*` types and the **reduced gaussian** grid
  (the flat value array is packed into a 2D texture; the per-row longitude
  count / index arithmetic of `grids/gaussian.ts` runs in the shader).
- **Seamless composite domains** render as one multi-layer pass: per-layer
  sampling functions are generated into a single shader and at every pixel
  the finest sub-domain with data wins (hard winner-takes-all, finest-first,
  like the CPU worker). Sub-layers load lazily per zoom level with the same
  viewport/lead-time gates as the CPU handler; a sub-layer joining or leaving
  the drawn set ramps in with a reveal morph out of (or back into) the
  coarser field instead of popping.
- **Advected temporal blend** (`setAdvection`, single-layer regular grids):
  during a timestep morph the scalar field is sampled upstream of the
  previous and downstream of the next frame along a displacement field, so
  precipitation/cloud features drift instead of cross-fading in place. The
  displacement comes from the configured wind variables (loaded as sibling
  variables through the shared state, scaled by the timestep interval and a
  steering factor). Seamless composites keep the plain blend.
- **Wind arrows** (`setArrows`, arrows.ts): a hybrid pass in the same layer.
  The CPU samples speed/direction at a sparse map-fixed lattice with the tile
  worker's samplers (incl. the seamless vector blend), the GPU draws one
  instanced arrow per anchor through `projectTile`. Each instance carries its
  previous and current state, mixed by the raster's temporal `u_mix`, so
  arrows rotate/grow/fade across timesteps. A foreshortening probe fades them
  at the globe's limb and polar convergence.
- **Wind particle animation** (`setParticles`, particles.ts): particles
  advect through the wind field and leave fading trails. State lives in
  ping-pong RGBA32F textures; the update pass samples u/v component textures
  (derived from speed + direction) with the same
  generated grid samplers as the raster, so all grid kinds and seamless
  composites work. Trails accumulate in screen-space RGBA8 buffers; a camera
  move reprojects the history (plane homography on flat mercator, a two-pass
  warp through mercator space on the globe and over terrain), so trails
  survive pan/zoom/rotate/pitch and the globe transition; only a projection
  variant switch clears them. Any variable with a direction pair animates
  (waves, swell, currents); `shape: 'dash'` draws motion-oriented dashes and
  `mode: 'rain'` falling streaks whose alpha follows the scalar field.
  Requires `EXT_color_buffer_float` (else the pass is a no-op).
- **Contour isolines** (`setContours`): `fwidth`-antialiased screen-space
  lines over the composite value in the same fragment pass, at every multiple
  of a step or at explicit levels (the URL's `intervals` / colour-scale
  breakpoints), with the CPU contour style's modulo classes. They morph with
  the temporal blend and follow the globe. Where the grid cells drop below a
  few pixels the lines come from a box-downsampled copy of the field in an
  extra lines-only pass (smooth world-view isobars instead of speckle).
- **Clipping**: rectangular bounds, and polygons through an in-shader mask
  (clip-mask.ts); `setClipping` restyles live without reloading data.
- **Globe projection**: every pass compiles its vertex stage around
  MapLibre's per-projection `shaderData` prelude (`projectTile`), so
  mercator, globe and the transition render natively; the raster mesh is
  subdivided so it curves around the sphere. Data poleward of the mercator
  clamp (±85.05°) leaves the polar caps empty on the globe.
- **3D terrain draping** (terrain-elevation.ts, surface-target.ts): MapLibre
  drapes only its built-in layer types, so with terrain enabled the layer
  builds its own mercator-space elevation texture from the map's raster-dem
  terrain tiles (the map's `get_elevation` logic, exaggeration applied) and
  every vertex shader lifts its vertices onto the ground. The passes render
  into an offscreen target with a depth pre-pass of the surface, so a ridge
  hides what lies behind it; the particles read the surface depth and
  visibility maps to hide behind relief as well.
- **Texture residency**: value textures are cached in VRAM under a byte
  budget (`textureCacheMb`), shared by every layer on the same GL context,
  so animation loops replay without re-uploads; `hasTextureForUrl` tells a
  host which timesteps are resident.

## Known gaps

- Banded (non-blend) colour scales sample a 2048-texel LUT with NEAREST, so
  band edges are quantised to `range/2048`; visually identical in practice,
  but an exact in-shader breakpoint search is the precise fix.
- fp32: shader math is single precision (CPU is double). Expect sub-pixel
  differences, and potential jitter at very high zoom (z ≳ 12); the standard
  fix (camera-relative coordinates) is a follow-up.
- NaN cells are encoded as a large sentinel at upload (`MISSING_SENTINEL`)
  because NaN in float textures is driver-dependent.
- WebGL context loss is not handled (recreate the layer / renderer).
