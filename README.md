# Open-Meteo Mapbox Layer

[![Test](https://github.com/open-meteo/mapbox-layer/actions/workflows/test.yml/badge.svg)](https://github.com/open-meteo/mapbox-layer/actions/workflows/test.yml)
[![GitHub license](https://img.shields.io/github/license/open-meteo/mapbox-layer)](https://github.com/open-meteo/mapbox-layer/blob/main/LICENSE)
[![npm version](https://img.shields.io/npm/v/@openmeteo/mapbox-layer?label=@openmeteo/mapbox-layer)](https://www.npmjs.com/package/@openmeteo/mapbox-layer)

> **⚠️ Notice**
> This package is still under construction and is not yet fully production‑ready.
> API changes may occur and some features might be incomplete.

## Overview

This repository demonstrates how to use the **Open‑Meteo File Protocol** (`.om`) with Mapbox / MapLibre GL JS.
The `.om` files are hosted on an S3 bucket and can be accessed directly via the `om` protocol:

The actual weather API implementation lives in the [open‑meteo/open‑meteo](https://github.com/open-meteo/open-meteo) repository.

An interactive demo is available at [maps.open‑meteo.com](https://maps.open‑meteo.com/).

## Installation

### Node

```bash
npm install @openmeteo/mapbox-layer
```

```ts
...
import { omProtocol } from '@openmeteo/mapbox-layer';

// standard mapbox / maplibre setup
...

maplibregl.addProtocol('om', omProtocol);

const omUrl = `https://map-tiles.open-meteo.com/data_spatial/dwd_icon/2025/10/15/1200Z/2025-10-15T1400.om?variable=temperature_2m`;

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
		source: 'omFileSource'
	});
});
```

### HTML / UNPKG

For a standalone example, see `examples/temperature.html`.

```ts
...
<script src="https://unpkg.com/@openmeteo/mapbox-layer@0.0.3/dist/index.js"></script>
...

<script>
	// Standard Mapbox / MapLibre GL JS setup
	// ...

	maplibregl.addProtocol('om', omProtocol);

	const omUrl = `https://map-tiles.open-meteo.com/data_spatial/dwd_icon/2025/10/15/1200Z/2025-10-15T1400.om?variable=temperature_2m`;

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
			source: 'omFileSource'
		});
	});
</script>
```

## Examples

The repository contains an `examples` directory with ready‑to‑run demos:

- `examples/temperature.html` – shows temperature data from an OM file.
- `examples/precipitation.html` – displays precipitation using a similar setup.
- `examples/wind.html` – displays wind values with directional arrows.
- `examples/custom-colorscale.html` – shows how to use your own color definition.

Run the examples by opening the corresponding `.html` file in a browser.

## Contouring

For contouring a new source must be added, since the contouring functionality uses vector tiles.

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

For the contouring there is the `examples/vector` directory with ready‑to‑run demos:

- `examples/vector/contouring-pressure.html` – shows how to use contouring with a pressure map
- `examples/vector/grid-points.html` – displays all grid points for a model, with value data on each point.
- `examples/vector/temperature_labels.html` – displays all grid points for a model, using value data to show temperature labels.
