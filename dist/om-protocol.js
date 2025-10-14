import { OmHttpBackend, OmDataType, setupGlobalCache } from "@openmeteo/file-reader";
import { WorkerPool } from "./worker-pool.js";
import { D as DynamicProjection, P as ProjectionGrid, d as getIndicesFromBounds, g as getBorderPoints, a as getBoundsFromBorderPoints, e as getBoundsFromGrid, f as getIndexFromLatLong } from "./math.js";
import { getInterpolator } from "./utils/color-scales.js";
import { domainOptions } from "./utils/domains.js";
import { variableOptions } from "./utils/variables.js";
import { pad } from "./utils/index.js";
import arrowPixelsSource from "./utils/arrow.js";
import "./utils/interpolations.js";
class OMapsFileReader {
  constructor(domain2, partial2) {
    this.setReaderData(domain2, partial2);
  }
  async init(omUrl) {
    this.dispose();
    const s3_backend = new OmHttpBackend({
      url: omUrl,
      eTagValidation: false,
      retries: 2
    });
    this.reader = await s3_backend.asCachedReader();
  }
  setReaderData(domain2, partial2) {
    this.partial = partial2;
    this.domain = domain2;
    if (domain2.grid.projection) {
      const projectionName = domain2.grid.projection.name;
      this.projection = new DynamicProjection(
        projectionName,
        domain2.grid.projection
      );
      this.projectionGrid = new ProjectionGrid(this.projection, domain2.grid);
    }
  }
  setRanges(ranges2, dimensions) {
    if (this.partial || !dimensions) {
      this.ranges = ranges2 ?? this.ranges;
    } else {
      this.ranges = [
        { start: 0, end: dimensions[0] },
        { start: 0, end: dimensions[1] }
      ];
    }
  }
  async readVariable(variable2, ranges2 = null) {
    let values, directions;
    if (variable2.value.includes("_u_component")) {
      const variableReaderU = await this.reader?.getChildByName(variable2.value);
      const variableReaderV = await this.reader?.getChildByName(
        variable2.value.replace("_u_component", "_v_component")
      );
      const dimensions = variableReaderU?.getDimensions();
      this.setRanges(ranges2, dimensions);
      const valuesUPromise = variableReaderU?.read(OmDataType.FloatArray, this.ranges);
      const valuesVPromise = variableReaderV?.read(OmDataType.FloatArray, this.ranges);
      const [valuesU, valuesV] = await Promise.all([valuesUPromise, valuesVPromise]);
      values = [];
      directions = [];
      if (valuesU && valuesV)
        for (const [i, uValue] of valuesU.entries()) {
          values.push(
            Math.sqrt(Math.pow(Number(uValue), 2) + Math.pow(Number(valuesV[i]), 2)) * 1.94384
          );
          directions.push(
            (Math.atan2(Number(uValue), Number(valuesV[i])) * (180 / Math.PI) + 360) % 360
          );
        }
    } else {
      const variableReader = await this.reader?.getChildByName(variable2.value);
      const dimensions = variableReader?.getDimensions();
      this.setRanges(ranges2, dimensions);
      values = await variableReader?.read(OmDataType.FloatArray, this.ranges);
    }
    if (variable2.value.includes("_speed_")) {
      const variableReader = await this.reader?.getChildByName(
        variable2.value.replace("_speed_", "_direction_")
      );
      directions = await variableReader?.read(OmDataType.FloatArray, this.ranges);
    }
    if (variable2.value === "wave_height") {
      const variableReader = await this.reader?.getChildByName(
        variable2.value.replace("wave_height", "wave_direction")
      );
      directions = await variableReader?.read(OmDataType.FloatArray, this.ranges);
    }
    return {
      values,
      directions
    };
  }
  getNextUrls(omUrl) {
    const re = new RegExp(/([0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}00)/);
    const matches = omUrl.match(re);
    let nextUrl, prevUrl;
    if (matches) {
      const date = /* @__PURE__ */ new Date("20" + matches[0].substring(0, matches[0].length - 2) + ":00Z");
      date.setUTCHours(date.getUTCHours() - 1);
      prevUrl = omUrl.replace(
        re,
        `${String(date.getUTCFullYear()).substring(2, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}00`
      );
      date.setUTCHours(date.getUTCHours() + 2);
      nextUrl = omUrl.replace(
        re,
        `${String(date.getUTCFullYear()).substring(2, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}00`
      );
    }
    if (prevUrl && nextUrl) {
      return [prevUrl, nextUrl];
    } else {
      return void 0;
    }
  }
  prefetch(omUrl) {
    const nextOmUrls = this.getNextUrls(omUrl);
    if (nextOmUrls) {
      for (const nextOmUrl of nextOmUrls) {
        fetch(nextOmUrl, {
          method: "GET",
          headers: {
            Range: "bytes=0-255"
            // Just fetch first 256 bytes to trigger caching
          }
        }).catch(() => {
        });
      }
    }
  }
  dispose() {
    if (this.child) {
      this.child.dispose();
    }
    if (this.reader) {
      this.reader.dispose();
    }
    delete this.child;
    delete this.reader;
  }
}
let dark = false;
let partial = false;
let domain;
let variable;
let mapBounds;
let omapsFileReader;
let mapBoundsIndexes;
let ranges;
let projection;
let projectionGrid;
setupGlobalCache();
const arrowPixelData = {};
const initPixelData = async () => {
  const loadIcon = async (key, iconUrl) => {
    const svgText = await fetch(iconUrl).then((r) => r.text());
    const canvas = new OffscreenCanvas(32, 32);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Failed to get 2D context"));
          return;
        }
        ctx.drawImage(img, 0, 0, 32, 32);
        arrowPixelData[key] = ctx.getImageData(0, 0, 32, 32).data;
        resolve(void 0);
      };
      img.onerror = reject;
      img.src = `data:image/svg+xml;base64,${btoa(svgText)}`;
    });
  };
  await Promise.all(Object.entries(arrowPixelsSource).map(([key, url]) => loadIcon(key, url)));
};
let data;
const TILE_SIZE = Number("256") * 2;
const workerPool = new WorkerPool();
const getValueFromLatLong = (lat, lon, colorScale) => {
  if (data) {
    const values = data.values;
    const lonMin = domain.grid.lonMin + domain.grid.dx * ranges[1]["start"];
    const latMin = domain.grid.latMin + domain.grid.dy * ranges[0]["start"];
    const lonMax = domain.grid.lonMin + domain.grid.dx * ranges[1]["end"];
    const latMax = domain.grid.latMin + domain.grid.dy * ranges[0]["end"];
    let indexObject;
    if (domain.grid.projection) {
      indexObject = projectionGrid.findPointInterpolated(lat, lon, ranges);
    } else {
      indexObject = getIndexFromLatLong(
        lat,
        lon,
        domain.grid.dx,
        domain.grid.dy,
        ranges[1]["end"] - ranges[1]["start"],
        [latMin, lonMin, latMax, lonMax]
      );
    }
    const { index, xFraction, yFraction } = indexObject ?? {
      index: NaN,
      xFraction: 0,
      yFraction: 0
    };
    if (values && index) {
      const interpolator = getInterpolator(colorScale);
      const px = interpolator(values, index, xFraction, yFraction, ranges);
      return { index, value: px };
    } else {
      return { index: NaN, value: NaN };
    }
  } else {
    return { index: NaN, value: NaN };
  }
};
const getTile = async ({ z, x, y }, omUrl) => {
  const key = `${omUrl}/${TILE_SIZE}/${z}/${x}/${y}`;
  let iconList = {};
  if (variable.value.startsWith("wind") || variable.value.startsWith("wave")) {
    iconList = arrowPixelData;
  }
  return await workerPool.requestTile({
    type: "GT",
    x,
    y,
    z,
    key,
    data,
    domain,
    variable,
    ranges,
    dark,
    mapBounds,
    iconPixelData: iconList
  });
};
const renderTile = async (url) => {
  const re = new RegExp(/om:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)/);
  const result = url.match(re);
  if (!result) {
    throw new Error(`Invalid OM protocol URL '${url}'`);
  }
  const urlParts = result[1].split("#");
  const omUrl = urlParts[0];
  const z = parseInt(result[2]);
  const x = parseInt(result[3]);
  const y = parseInt(result[4]);
  const tile = await getTile({ z, x, y }, omUrl);
  return tile;
};
const getTilejson = async (fullUrl) => {
  let bounds;
  if (domain.grid.projection) {
    const projectionName = domain.grid.projection.name;
    projection = new DynamicProjection(
      projectionName,
      domain.grid.projection
    );
    projectionGrid = new ProjectionGrid(projection, domain.grid);
    const borderPoints = getBorderPoints(projectionGrid);
    bounds = getBoundsFromBorderPoints(borderPoints, projection);
  } else {
    bounds = getBoundsFromGrid(
      domain.grid.lonMin,
      domain.grid.latMin,
      domain.grid.dx,
      domain.grid.dy,
      domain.grid.nx,
      domain.grid.ny
    );
  }
  return {
    tilejson: "2.2.0",
    tiles: [fullUrl + "/{z}/{x}/{y}"],
    attribution: '<a href="https://open-meteo.com">Open-Meteo</a>',
    minzoom: 0,
    maxzoom: 12,
    bounds
  };
};
const initOMFile = (url) => {
  initPixelData();
  return new Promise((resolve, reject) => {
    const [omUrl, omParams] = url.replace("om://", "").split("?");
    const urlParams = new URLSearchParams(omParams);
    dark = urlParams.get("dark") === "true";
    partial = urlParams.get("partial") === "true";
    domain = domainOptions.find((dm) => dm.value === omUrl.split("/")[4]) ?? domainOptions[0];
    variable = variableOptions.find((v) => urlParams.get("variable") === v.value) ?? variableOptions[0];
    mapBounds = urlParams.get("bounds")?.split(",").map((b) => Number(b));
    mapBoundsIndexes = getIndicesFromBounds(
      mapBounds[0],
      mapBounds[1],
      mapBounds[2],
      mapBounds[3],
      domain
    );
    if (partial) {
      ranges = [
        { start: mapBoundsIndexes[1], end: mapBoundsIndexes[3] },
        { start: mapBoundsIndexes[0], end: mapBoundsIndexes[2] }
      ];
    } else {
      ranges = [
        { start: 0, end: domain.grid.ny },
        { start: 0, end: domain.grid.nx }
      ];
    }
    if (!omapsFileReader) {
      omapsFileReader = new OMapsFileReader(domain, partial);
    }
    omapsFileReader.setReaderData(domain, partial);
    omapsFileReader.init(omUrl).then(() => {
      omapsFileReader.readVariable(variable, ranges).then((values) => {
        data = values;
        resolve();
        omapsFileReader.prefetch(omUrl);
      });
    }).catch((e) => {
      reject(e);
    });
  });
};
const omProtocol = async (params) => {
  if (params.type == "json") {
    try {
      await initOMFile(params.url);
    } catch (e) {
      throw new Error(e);
    }
    return {
      data: await getTilejson(params.url)
    };
  } else if (params.type == "image") {
    return {
      data: await renderTile(params.url)
    };
  } else {
    throw new Error(`Unsupported request type '${params.type}'`);
  }
};
export {
  getValueFromLatLong,
  omProtocol
};
