# Open-Meteo Mapbox Layer

[![codecov](https://codecov.io/gh/open-meteo/mapbox-layer/graph/badge.svg?token=E2WYHGJJHP)](https://codecov.io/gh/open-meteo/mapbox-layer)
[![Linting & Tests](https://github.com/open-meteo/mapbox-layer/actions/workflows/ci.yml/badge.svg)](https://github.com/open-meteo/mapbox-layer/actions/workflows/ci.yml)
[![GitHub license](https://img.shields.io/github/license/open-meteo/mapbox-layer)](https://github.com/open-meteo/mapbox-layer/blob/main/LICENSE)
[![npm version](https://img.shields.io/npm/v/@openmeteo/mapbox-layer?label=@openmeteo/mapbox-layer)](https://www.npmjs.com/package/@openmeteo/mapbox-layer)

> **⚠️ Notice**
> This package is still under construction and is not yet fully production-ready.
> API changes may occur and some features might be incomplete.

## Overview

This repository serves as a demonstration of the **Open-Meteo File Protocol** (`om://`) with Mapbox / MapLibre GL JS. The `.om` files are hosted on an S3 bucket and can be accessed directly through the protocol handler.

The core weather data generation and API is hosted in the [open-meteo/open-meteo](https://github.com/open-meteo/open-meteo) repository.

An interactive demo is available at [maps.open-meteo.com](https://maps.open-meteo.com/).

## Installation

### Node

```bash
npm install @openmeteo/mapbox-layer
```

```ts
// ...
import { omProtocol } from '@openmeteo/mapbox-layer';

// Standard Mapbox / MapLibre GL JS setup
// ...

maplibregl.addProtocol('om', omProtocol);

const omUrl = `https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json?variable=temperature_2m`;

map.on('load', () => {
	map.addSource('omFileSource', {
		url: 'om://' + omUrl,
		type: 'raster',
		tileSize: 256,
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

```ts
...
<script src="https://unpkg.com/@openmeteo/mapbox-layer@0.0.12/dist/index.js"></script>
...
```

<!-- x-release-please-end -->

```ts
<script>
	// Standard Mapbox / MapLibre GL JS setup
	// ...

	maplibregl.addProtocol('om', OpenMeteoMapboxLayer.omProtocol);

	const omUrl = `https://map-tiles.open-meteo.com/data_spatial/dwd_icon/latest.json?variable=temperature_2m`;

	map.on('load', () => {
		map.addSource('omFileSource', {
			url: 'om://' + omUrl,
			type: 'raster',
			tileSize: 256,
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

### Contouring

- `examples/vector/contouring/contouring-pressure.html` – shows how to use contouring with a pressure map.
- `examples/vector/contouring/contouring-on-colorscale.html` – shows how to use contouring to follow the breakpoints in the colorscale.
- `examples/vector/contouring/custom-contouring-interval.html` – shows how to use contouring a custom contouring interval.

### Colors

If you’re rendering tiles on a dark base‑map or simply want to experiment with alternative color schemes, the documentation includes several example pages that illustrate all the available color‑scale options:

- `examples/colorscales/darkmode.html` – demonstrates the `dark=true` URL parameter, which automatically switches to palettes fine‑tuned for dark backgrounds.
- `examples/colorscales/custom-rgba.html` – shows how to build a linear gradient from a user‑defined array of RGBA values.
- `examples/colorscales/custom-breakpoint.html` – demonstrates how to insert your own breakpoints into the scale definitions.

### Callbacks

In scenarios where post‑loading transformations of weather data is required, the protocol provides a post‑read callback. This callback is invoked immediately after the data has been parsed by `omFileReader`, allowing transformations before the data is forwarded to the rendering pipeline. A typical usage pattern is illustrated below:

```ts
const omProtocolOptions = OpenMeteoMapboxLayer.defaultOmProtocolSettings;
omProtocolOptions.postReadCallback = (omFileReader, data, state) => {
	if (data.values) {
		data.values = data.values?.map((value) => value / 100);
	}
};

maplibregl.addProtocol('om', (params) =>
	OpenMeteoMapboxLayer.omProtocol(params, undefined, omProtocolOptions)
);
```

An example implementation with a usefull case is available in the `examples/callbacks` sub-directory.

### Clipping

To restrict weather data to a geometric boundary, the clipping parameters can be supplied during the instantiation of the omProtocol.

```ts
const omProtocolOptions = OpenMeteoMapboxLayer.defaultOmProtocolSettings;
omProtocolOptions.clippingOptions = {
	polygons: polygonList, // optionally clip raster / vector data to these polygons
	bounds: clipBbox // optionally limit tile generation to these bbox bounds
};
...
```

- `examples/clipping/raster/clip-switzerland.html` – Demonstrates temperature raster data clipped to the geographical contour of Switzerland.
- `examples/clipping/arrows/clip-italy.html` – Shows wind velocity raster and vector arrow fields clipped to the contour of Italy.
- `examples/clipping/contours/clip-france.html` – Illustrates temperature and isocontour overlays confined to the French boundary.
- `examples/clipping/oceans/clip-oceans.html` – Depicts the exclusion of oceanic regions from a global model, thereby hiding weather data on ocean surfaces.

## Capture API

> **⚠️** Using the Capture API will add 0.5-1s delay for each request

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

| modifier | Alteration |
| -------- | ---------- |
| M        | Minutes    |
| H        | Hours      |
| d        | Days       |
| m        | Months     |
