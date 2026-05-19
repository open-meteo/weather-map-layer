# Open-Meteo Weather Map Layer

[![codecov](https://codecov.io/gh/open-meteo/weather-map-layer/graph/badge.svg?token=E2WYHGJJHP)](https://codecov.io/gh/open-meteo/weather-map-layer)
[![Linting & Tests](https://github.com/open-meteo/weather-map-layer/actions/workflows/ci.yml/badge.svg)](https://github.com/open-meteo/weather-map-layer/actions/workflows/ci.yml)
[![GitHub license](https://img.shields.io/github/license/open-meteo/weather-map-layer)](https://github.com/open-meteo/weather-map-layer/blob/main/LICENSE)
[![npm version](https://img.shields.io/npm/v/@openmeteo/weather-map-layer?label=@openmeteo/weather-map-layer)](https://www.npmjs.com/package/@openmeteo/weather-map-layer)

> **⚠️ Notice**
> This package is still under construction and is not yet fully production-ready.
> API changes may occur and some features might be incomplete.

## Overview

This repository serves as a demonstration of the **Open-Meteo File Protocol** (`om://`) with Mapbox / MapLibre GL JS. The `om://` scheme is a custom [MapLibre protocol](https://maplibre.org/maplibre-gl-js/docs/API/functions/addProtocol/) registered via `addProtocol`. The `.om` files are hosted on an S3 bucket and can be accessed directly through the protocol handler.

The core weather data generation and API is hosted in the [open-meteo/open-meteo](https://github.com/open-meteo/open-meteo) repository.

An interactive demo is available at [maps.open-meteo.com](https://maps.open-meteo.com/).

## Installation

### Node

```bash
npm install @openmeteo/weather-map-layer
```

```ts
// ...
import { omProtocol } from '@openmeteo/weather-map-layer';

// Standard MapLibre GL JS setup
// ...

maplibregl.addProtocol('om', omProtocol);

const omUrl = `https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json?variable=temperature_2m`;

map.on('load', () => {
	map.addSource('omFileSource', {
		url: 'om://' + omUrl,
		type: 'raster',
		maxzoom: 12 // tiles look pretty much the same below zoom-level 12, even on the high res models
	});

	map.addLayer({
		id: 'omFileLayer',
		type: 'raster',
		source: 'omFileSource',
		paint: {
			'raster-opacity': 0.75
		}
	});
});
```

### HTML / UNPKG

For a standalone example, see `examples/temperature.html`.

<!-- x-release-please-start-version -->

```html
...
<script src="https://unpkg.com/@openmeteo/weather-map-layer@0.0.20/dist/index.js"></script>
...
```

<!-- x-release-please-end -->

```html
<script>
	// Standard MapLibre GL JS setup
	// ...

	maplibregl.addProtocol('om', OMWeatherMapLayer.omProtocol);

	const omUrl = `https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json?variable=temperature_2m`;

	map.on('load', () => {
		map.addSource('omFileSource', {
			url: 'om://' + omUrl,
			type: 'raster',
			maxzoom: 12 // tiles look pretty much the same below zoom-level 12, even on the high res models
		});

		map.addLayer({
			id: 'omFileLayer',
			type: 'raster',
			source: 'omFileSource',
			paint: {
				'raster-opacity': 0.75
			}
		});
	});
</script>
```

## Development

The examples can be served locally, providing direct access to the bundled assets and data files. To launch the development server, execute:

```bash
npm run serve
```

This command initiates a lightweight static server, enabling the interactive demos to be viewed in a browser while reflecting any code changes in real time.

## Examples

### Raster sources

The repository contains an `examples` directory with ready-to-run demos:

- `examples/temperature.html` – shows temperature data from an OM file.
- `examples/precipitation.html` – displays precipitation using a similar setup.
- `examples/wind.html` – displays wind values, for arrows overlay see [Vector sources](#vector-sources).
- `examples/combined-variables.html` – shows multiple data sources on the same map.
- `examples/partial-requests.html` – demonstrates partial / incremental data requests.

Run the examples by opening the corresponding `.html` file in a browser.

### Vector sources

For directional arrows / contouring / gridpoints, an additional source must be added, since these features use vector tiles instead of raster tiles.

```ts
...

map.on('load', () => {
	map.addSource('omFileVectorSource', {
		url: 'om://' + omUrl,
		type: 'vector'
	});

	map.addLayer({
		id: 'omFileVectorLayer',
		type: 'line',
		source: 'omFileVectorSource',
		'source-layer': 'contours',
		paint: {
			'line-color': 'black',
			'line-width': 4
		}
	});
});
```

For the vector source examples there is the `examples/vector` sub-directory with ready-to-run demos:

- `examples/vector/grid-points.html` – displays all grid points for a model, with value data on each point.
- `examples/vector/temperature-anomaly.html` – shows a seasonal forecast map with temperature anomalies.
- `examples/vector/temperature-labels.html` – displays all grid points for a model, using value data to show temperature labels.
- `examples/vector/wind-arrows.html` – displays wind map with directional arrows.

## Framework Adapters

The core `omProtocol` handler is designed for MapLibre GL JS, but this package also ships adapters for **Mapbox GL JS**, **Leaflet** and **OpenLayers**. Each adapter provides `addProtocol` / `removeProtocol` plus factory methods for creating map-library-native source or layer objects.

#### Maptiler SDK

The Maptiler SDK natively supports `addProtocol`, but unfortunately it mangles the param url, by removing the second `:`, this small snippet will fix that:

```ts
// MapTiler SDK mangles URLs like `om://https://...` into `om://https//...`
maptilersdk.addProtocol('om', (params, abortController) => {
	params.url = params.url.replace('https//', 'https://');
	return omProtocol(params, abortController, omProtocolSettings);
});
```

### Contouring

- `examples/vector/contouring/contouring-pressure.html` – shows how to use contouring with a pressure map.
- `examples/vector/contouring/contouring-on-colorscale.html` – shows how to use contouring to follow the breakpoints in the colorscale.
- `examples/vector/contouring/custom-contouring-intervals.html` – shows how to use contouring with a custom contouring interval.

### Colors

If you’re rendering tiles on a dark base‑map or simply want to experiment with alternative color schemes, the documentation includes several example pages that illustrate all the available color‑scale options:

- `examples/colorscales/darkmode.html` – demonstrates the `dark=true` URL parameter, which automatically switches to palettes fine‑tuned for dark backgrounds.
- `examples/colorscales/custom-rgba.html` – shows how to build a linear gradient from a user‑defined array of RGBA values.
- `examples/colorscales/custom-breakpoints.html` – demonstrates how to insert your own breakpoints into the scale definitions.

### Callbacks

In scenarios where post‑loading transformations of weather data is required, the protocol provides a post‑read callback. This callback is invoked immediately after the data has been parsed by `omFileReader`, allowing transformations before the data is forwarded to the rendering pipeline. A typical usage pattern is illustrated below:

```ts
const omProtocolOptions = OMWeatherMapLayer.defaultOmProtocolSettings;
omProtocolOptions.postReadCallback = (omFileReader, data, state) => {
	if (data.values) {
		data.values = data.values?.map((value) => value / 100);
	}
};

maplibregl.addProtocol('om', (params, abortController) =>
	OMWeatherMapLayer.omProtocol(params, abortController, omProtocolOptions)
);
```

An example implementation with a useful case is available in the `examples/callbacks` sub-directory.

### Clipping

To restrict weather data to a geometric boundary, the clipping parameters can be supplied during the instantiation of the omProtocol.

```ts
const omProtocolOptions = OMWeatherMapLayer.defaultOmProtocolSettings;
omProtocolOptions.clippingOptions = {
	geojson: geojson, // optionally clip weather data to geojson
	bounds: clipBbox // optionally limit tile generation to bbox bounds, automatically generated from geojson when left blank
};
...
```

The clipping examples require `npm run serve`, as they load GeoJSON files over HTTP.

- `examples/clipping/raster/clip-switzerland.html` – Demonstrates temperature raster data clipped to the geographical contour of Switzerland.
- `examples/clipping/arrows/clip-italy.html` – Shows wind velocity raster and vector arrow fields clipped to the contour of Italy.
- `examples/clipping/contours/clip-france.html` – Illustrates temperature and isocontour overlays confined to the French boundary.
- `examples/clipping/bounds/clip-germany-bounds.html` – Restricts tile generation to a bounding box around Germany.
- `examples/clipping/oceans/clip-oceans.html` – Depicts the exclusion of oceanic regions from a global model, thereby hiding weather data on ocean surfaces.

## Capture API

> **⚠️** Using the Capture API will add 0.5-1s delay for each request, because it must first fetch a metadata JSON file to resolve the latest model run before requesting the actual `.om` tile data.

Because the use of OM files on the S3 storage is often quite ambiguous, a Capture API is added, that will automatically produce the correct file paths for you.

For each Weather Model, there will be a `latest.json` and `in-progress.json` metadata file, containing data like valid time steps, valid variables and reference times.

An example can be found [here](https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json), for `DWD Icon Global`:

```
https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json
```

```json
{
	"completed": true,
	"last_modified_time": "2025-11-11T09:42:17Z",
	"reference_time": "2025-11-11T06:00:00Z",
	"valid_times": ["2025-11-11T06:00Z", "2025-11-11T07:00Z", "...+91"],
	"variables": ["cape", "cloud_cover", "cloud_cover_high", "...+120"]
}
```

### Using the Capture API

If you don't want to select a particular model run, but instead always want to use the latest available run. Instead of using the model run in the URL you replace that part with `latest.json`

For example, with the link below replace the highlighted part:

<pre><code>https://map-tiles.open-meteo.com/data_spatial/dwd_icon/<b style="color:#af1111">2025/06/06/1200Z/2025-06-06T1200.om</b>?variable=temperature_2m
</code></pre>

With `latest.json`:

<pre><code>https://map-tiles.open-meteo.com/data_spatial/dwd_icon/<b style="color:#14a62d">latest.json</b>?variable=temperature_2m
</code></pre>

If you want to show the closest current time, or a pick a different valid time than the first one, you could use:

<pre><code>https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json?<b>time_step=current_time_1H</b>&variable=temperature_2m
</code></pre>

or the 5th index of the `valid_times` array

<pre><code>https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json?<b>time_step=valid_times_5</b>&variable=temperature_2m
</code></pre>

### Time Step Modifiers

The modifier suffix on `current_time_` controls the rounding granularity when snapping to the nearest available time step. For example, `current_time_1H` rounds to the nearest hour, while `current_time_30M` rounds to the nearest 30 minutes.

| modifier | Alteration |
| -------- | ---------- |
| M        | Minutes    |
| H        | Hours      |
| d        | Days       |
| m        | Months     |

## License

This project is licensed under the [GNU General Public License v2.0](LICENSE).
