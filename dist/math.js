class MercatorProjection {
  forward(latitude, longitude) {
    const x = lon2tile(longitude, 0);
    const y = lat2tile(latitude, 0);
    return [x, y];
  }
  reverse(x, y) {
    const lon = tile2lon(x, 0);
    const lat = tile2lat(y, 0);
    return [lat, lon];
  }
}
class RotatedLatLonProjection {
  constructor(projectionData) {
    if (projectionData) {
      const rotation = projectionData.rotation ?? [0, 0];
      this.θ = degreesToRadians(90 + rotation[0]);
      this.ϕ = degreesToRadians(rotation[1]);
    } else {
      throw new Error("projectionData not defined");
    }
  }
  forward(latitude, longitude) {
    const lon = degreesToRadians(longitude);
    const lat = degreesToRadians(latitude);
    const x1 = Math.cos(lon) * Math.cos(lat);
    const y1 = Math.sin(lon) * Math.cos(lat);
    const z1 = Math.sin(lat);
    const x2 = Math.cos(this.θ) * Math.cos(this.ϕ) * x1 + Math.cos(this.θ) * Math.sin(this.ϕ) * y1 + Math.sin(this.θ) * z1;
    const y2 = -Math.sin(this.ϕ) * x1 + Math.cos(this.ϕ) * y1;
    const z2 = -Math.sin(this.θ) * Math.cos(this.ϕ) * x1 - Math.sin(this.θ) * Math.sin(this.ϕ) * y1 + Math.cos(this.θ) * z1;
    const x = -1 * radiansToDegrees(Math.atan2(y2, x2));
    const y = -1 * radiansToDegrees(Math.asin(z2));
    return [x, y];
  }
  reverse(x, y) {
    const lon1 = degreesToRadians(x);
    const lat1 = degreesToRadians(y);
    const lat2 = -1 * Math.asin(
      Math.cos(this.θ) * Math.sin(lat1) - Math.cos(lon1) * Math.sin(this.θ) * Math.cos(lat1)
    );
    const lon2 = -1 * (Math.atan2(
      Math.sin(lon1),
      Math.tan(lat1) * Math.sin(this.θ) + Math.cos(lon1) * Math.cos(this.θ)
    ) - this.ϕ);
    const lon = (radiansToDegrees(lon2) + 180) % 360 - 180;
    const lat = radiansToDegrees(lat2);
    return [lat, lon];
  }
}
class LambertConformalConicProjection {
  // Radius of the Earth
  constructor(projectionData) {
    this.R = 6370.997;
    let λ0_dec;
    let ϕ0_dec;
    let ϕ1_dec;
    let ϕ2_dec;
    let radius;
    if (projectionData) {
      λ0_dec = projectionData.λ0;
      ϕ0_dec = projectionData.ϕ0;
      ϕ1_dec = projectionData.ϕ1;
      ϕ2_dec = projectionData.ϕ2;
      radius = projectionData.radius;
    } else {
      throw new Error("projectionData not defined");
    }
    this.λ0 = degreesToRadians((λ0_dec + 180) % 360 - 180);
    const ϕ0 = degreesToRadians(ϕ0_dec);
    const ϕ1 = degreesToRadians(ϕ1_dec);
    const ϕ2 = degreesToRadians(ϕ2_dec);
    if (ϕ1 == ϕ2) {
      this.n = Math.sin(ϕ1);
    } else {
      this.n = Math.log(Math.cos(ϕ1) / Math.cos(ϕ2)) / Math.log(Math.tan(Math.PI / 4 + ϕ2 / 2) / Math.tan(Math.PI / 4 + ϕ1 / 2));
    }
    this.F = Math.cos(ϕ1) * Math.pow(Math.tan(Math.PI / 4 + ϕ1 / 2), this.n) / this.n;
    this.ρ0 = this.F / Math.pow(Math.tan(Math.PI / 4 + ϕ0 / 2), this.n);
    if (radius) {
      this.R = radius;
    }
  }
  forward(latitude, longitude) {
    const ϕ = degreesToRadians(latitude);
    const λ = degreesToRadians(longitude);
    const θ = this.n * (λ - this.λ0);
    const p = this.F / Math.pow(Math.tan(Math.PI / 4 + ϕ / 2), this.n);
    const x = this.R * p * Math.sin(θ);
    const y = this.R * (this.ρ0 - p * Math.cos(θ));
    return [x, y];
  }
  reverse(x, y) {
    const x_scaled = x / this.R;
    const y_scaled = y / this.R;
    const θ = this.n >= 0 ? Math.atan2(x_scaled, this.ρ0 - y_scaled) : Math.atan2(-1 * x_scaled, y_scaled - this.ρ0);
    const ρ = (this.n > 0 ? 1 : -1) * Math.sqrt(Math.pow(x_scaled, 2) + Math.pow(this.ρ0 - y_scaled, 2));
    const ϕ_rad = 2 * Math.atan(Math.pow(this.F / ρ, 1 / this.n)) - Math.PI / 2;
    const λ_rad = this.λ0 + θ / this.n;
    const λ = radiansToDegrees(λ_rad);
    const lat = radiansToDegrees(ϕ_rad);
    const lon = λ > 180 ? λ - 360 : λ;
    return [lat, lon];
  }
}
class LambertAzimuthalEqualAreaProjection {
  // Radius of the Earth
  constructor(projectionData) {
    this.R = 6371229;
    if (projectionData) {
      const λ0_dec = projectionData.λ0;
      const ϕ1_dec = projectionData.ϕ1;
      const radius = projectionData.radius;
      this.λ0 = degreesToRadians(λ0_dec);
      this.ϕ1 = degreesToRadians(ϕ1_dec);
      if (radius) {
        this.R = radius;
      }
    } else {
      throw new Error("projectionData not defined");
    }
  }
  forward(latitude, longitude) {
    const λ = degreesToRadians(longitude);
    const ϕ = degreesToRadians(latitude);
    const k = Math.sqrt(
      2 / (1 + Math.sin(this.ϕ1) * Math.sin(ϕ) + Math.cos(this.ϕ1) * Math.cos(ϕ) * Math.cos(λ - this.λ0))
    );
    const x = this.R * k * Math.cos(ϕ) * Math.sin(λ - this.λ0);
    const y = this.R * k * (Math.cos(this.ϕ1) * Math.sin(ϕ) - Math.sin(this.ϕ1) * Math.cos(ϕ) * Math.cos(λ - this.λ0));
    return [x, y];
  }
  reverse(x, y) {
    x = x / this.R;
    y = y / this.R;
    const ρ = Math.sqrt(x * x + y * y);
    const c = 2 * Math.asin(0.5 * ρ);
    const ϕ = Math.asin(
      Math.cos(c) * Math.sin(this.ϕ1) + y * Math.sin(c) * Math.cos(this.ϕ1) / ρ
    );
    const λ = this.λ0 + Math.atan(
      x * Math.sin(c) / (ρ * Math.cos(this.ϕ1) * Math.cos(c) - y * Math.sin(this.ϕ1) * Math.sin(c))
    );
    const lat = radiansToDegrees(ϕ);
    const lon = radiansToDegrees(λ);
    return [lat, lon];
  }
}
class StereograpicProjection {
  // Radius of Earth
  constructor(projectionData) {
    this.R = 6371229;
    if (projectionData) {
      this.λ0 = degreesToRadians(projectionData.longitude);
      this.sinϕ1 = Math.sin(degreesToRadians(projectionData.latitude));
      this.cosϕ1 = Math.cos(degreesToRadians(projectionData.latitude));
      if (projectionData.radius) {
        this.R = projectionData.radius;
      }
    } else {
      throw new Error("projectionData not defined");
    }
  }
  forward(latitude, longitude) {
    const ϕ = degreesToRadians(latitude);
    const λ = degreesToRadians(longitude);
    const k = 2 * this.R / (1 + this.sinϕ1 * Math.sin(ϕ) + this.cosϕ1 * Math.cos(ϕ) * Math.cos(λ - this.λ0));
    const x = k * Math.cos(ϕ) * Math.sin(λ - this.λ0);
    const y = k * (this.cosϕ1 * Math.sin(ϕ) - this.sinϕ1 * Math.cos(ϕ) * Math.cos(λ - this.λ0));
    return [x, y];
  }
  reverse(x, y) {
    const p = Math.sqrt(x * x + y * y);
    const c = 2 * Math.atan2(p, 2 * this.R);
    const ϕ = Math.asin(Math.cos(c) * this.sinϕ1 + y * Math.sin(c) * this.cosϕ1 / p);
    const λ = this.λ0 + Math.atan2(x * Math.sin(c), p * this.cosϕ1 * Math.cos(c) - y * this.sinϕ1 * Math.sin(c));
    const lat = radiansToDegrees(ϕ);
    const lon = radiansToDegrees(λ);
    return [lat, lon];
  }
}
const projections = {
  MercatorProjection,
  StereograpicProjection,
  RotatedLatLonProjection,
  LambertConformalConicProjection,
  LambertAzimuthalEqualAreaProjection
};
class DynamicProjection {
  constructor(projName, opts) {
    return new projections[projName](opts);
  }
}
class ProjectionGrid {
  constructor(projection, grid, ranges = [
    { start: 0, end: grid.ny },
    { start: 0, end: grid.nx }
  ]) {
    this.ranges = ranges;
    this.projection = projection;
    const latitude = grid.projection?.latitude ?? grid.latMin;
    const longitude = grid.projection?.longitude ?? grid.lonMin;
    const projectOrigin = grid.projection?.projectOrigin ?? true;
    this.nx = grid.nx;
    this.ny = grid.ny;
    if (latitude && Array === latitude.constructor && Array === longitude.constructor) {
      const sw = projection.forward(latitude[0], longitude[0]);
      const ne = projection.forward(latitude[1], longitude[1]);
      this.origin = sw;
      this.dx = (ne[0] - sw[0]) / this.nx;
      this.dy = (ne[1] - sw[1]) / this.ny;
    } else if (projectOrigin) {
      this.dx = grid.dx;
      this.dy = grid.dy;
      this.origin = this.projection.forward(latitude, longitude);
    } else {
      this.dx = grid.dx;
      this.dy = grid.dy;
      this.origin = [latitude, longitude];
    }
  }
  findPointInterpolated(lat, lon, ranges) {
    const [xPos, yPos] = this.projection.forward(lat, lon);
    const minX = this.origin[0] + this.dx * ranges[1]["start"];
    const minY = this.origin[1] + this.dy * ranges[0]["start"];
    const x = (xPos - minX) / this.dx;
    const y = (yPos - minY) / this.dy;
    const xFraction = x - Math.floor(x);
    const yFraction = y - Math.floor(y);
    if (x < 0 || x >= ranges[1]["end"] - ranges[1]["start"] || y < 0 || y >= ranges[0]["end"] - ranges[0]["start"]) {
      return { index: NaN, xFraction: 0, yFraction: 0 };
    }
    const index = Math.floor(y) * (ranges[1]["end"] - ranges[1]["start"]) + Math.floor(x);
    return { index, xFraction, yFraction };
  }
}
const PI = Math.PI;
const degreesToRadians = (degree) => {
  return degree * (PI / 180);
};
const radiansToDegrees = (rad) => {
  return rad * (180 / PI);
};
const tile2lon = (x, z) => {
  return x / Math.pow(2, z) * 360 - 180;
};
const tile2lat = (y, z) => {
  const n = PI - 2 * PI * y / Math.pow(2, z);
  return radiansToDegrees(Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
};
const lon2tile = (lon, z) => {
  return Math.pow(2, z) * ((lon + 180) / 360);
};
const lat2tile = (lat, z) => {
  return Math.pow(2, z) * (1 - Math.log(Math.tan(degreesToRadians(lat)) + 1 / Math.cos(degreesToRadians(lat))) / PI) / 2;
};
const a1 = 0.99997726;
const a3 = -0.33262347;
const a5 = 0.19354346;
const a7 = -0.11643287;
const a9 = 0.05265332;
const a11 = -0.0117212;
const fastAtan2 = (y, x) => {
  const swap = Math.abs(x) < Math.abs(y);
  const denominator = (swap ? y : x) === 0 ? 1e-8 : swap ? y : x;
  const atan_input = (swap ? x : y) / denominator;
  const z_sq = atan_input * atan_input;
  let res = atan_input * (a1 + z_sq * (a3 + z_sq * (a5 + z_sq * (a7 + z_sq * (a9 + z_sq * a11)))));
  if (swap) res = Math.sign(atan_input) * PI / 2 - res;
  if (x < 0) res = Math.sign(y) * PI + res;
  return res;
};
const hermite = (t, p0, p1, m0, m1) => {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
};
const derivative = (fm1, fp1) => {
  return (fp1 - fm1) / 2;
};
const secondDerivative = (fm1, f0, fp1) => {
  return fm1 - 2 * f0 + fp1;
};
const getIndexFromLatLong = (lat, lon, dx, dy, nx, latLonMinMax) => {
  if (lat < latLonMinMax[0] || lat >= latLonMinMax[2] || lon < latLonMinMax[1] || lon >= latLonMinMax[3]) {
    return { index: NaN, xFraction: 0, yFraction: 0 };
  } else {
    const x = Math.floor((lon - latLonMinMax[1]) / dx);
    const y = Math.floor((lat - latLonMinMax[0]) / dy);
    const xFraction = (lon - latLonMinMax[1]) % dx / dx;
    const yFraction = (lat - latLonMinMax[0]) % dy / dy;
    const index = y * nx + x;
    return { index, xFraction, yFraction };
  }
};
const getIndicesFromBounds = (south, west, north, east, domain) => {
  let dx = domain.grid.dx;
  let dy = domain.grid.dy;
  const nx = domain.grid.nx;
  const ny = domain.grid.ny;
  let xPrecision, yPrecision;
  if (String(dx).split(".")[1]) {
    xPrecision = String(dx).split(".")[1].length;
    yPrecision = String(dy).split(".")[1].length;
  } else {
    xPrecision = 2;
    yPrecision = 2;
  }
  let s, w, n, e;
  let minX, minY, maxX, maxY;
  if (domain.grid.projection) {
    const projectionName = domain.grid.projection.name;
    const projection = new DynamicProjection(
      projectionName,
      domain.grid.projection
    );
    const projectionGrid = new ProjectionGrid(projection, domain.grid);
    [s, w, n, e] = getRotatedSWNE(domain, projection, [south, west, north, east]);
    dx = projectionGrid.dx;
    dy = projectionGrid.dy;
    s = Number((s - s % dy).toFixed(yPrecision));
    w = Number((w - w % dx).toFixed(xPrecision));
    n = Number((n - n % dy + dy).toFixed(yPrecision));
    e = Number((e - e % dx + dx).toFixed(xPrecision));
    const originX = projectionGrid.origin[0];
    const originY = projectionGrid.origin[1];
    if (dx > 0) {
      minX = Math.min(Math.max(Math.floor((w - originX) / dx - 1), 0), nx);
      maxX = Math.max(Math.min(Math.ceil((e - originX) / dx + 1), nx), 0);
    } else {
      minX = Math.min(Math.max(Math.floor((e - originX) / dx - 1), 0), nx);
      maxX = Math.max(Math.min(Math.ceil((w - originX) / dx + 1), nx), 0);
    }
    if (dy > 0) {
      minY = Math.min(Math.max(Math.floor((s - originY) / dy - 1), 0), ny);
      maxY = Math.max(Math.min(Math.ceil((n - originY) / dy + 1), ny), 0);
    } else {
      minY = Math.min(Math.max(Math.floor((n - originY) / dy - 1), 0), ny);
      maxY = Math.max(Math.min(Math.ceil((s - originY) / dy + 1), ny), 0);
    }
  } else {
    const originX = domain.grid.lonMin;
    const originY = domain.grid.latMin;
    s = Number((south - south % dy).toFixed(yPrecision));
    w = Number((west - west % dx).toFixed(xPrecision));
    n = Number((north - north % dy + dy).toFixed(yPrecision));
    e = Number((east - east % dx + dx).toFixed(xPrecision));
    if (s - originY < 0) {
      minY = 0;
    } else {
      minY = Math.floor(Math.max((s - originY) / dy - 1, 0));
    }
    if (w - originX < 0) {
      minX = 0;
    } else {
      minX = Math.floor(Math.max((w - originX) / dx - 1, 0));
    }
    if (n - originY < 0) {
      maxY = ny;
    } else {
      maxY = Math.ceil(Math.min((n - originY) / dy + 1, ny));
    }
    if (e - originX < 0) {
      maxX = nx;
    } else {
      maxX = Math.ceil(Math.min((e - originX) / dx + 1, nx));
    }
  }
  return [minX, minY, maxX, maxY];
};
const getRotatedSWNE = (domain, projection, [south, west, north, east]) => {
  const pointsX = [];
  const pointsY = [];
  for (let i = south; i < north; i += 0.01) {
    const point = projection.forward(i, west);
    pointsX.push(point[0]);
    pointsY.push(point[1]);
  }
  for (let i = west; i < east; i += 0.01) {
    const point = projection.forward(north, i);
    pointsX.push(point[0]);
    pointsY.push(point[1]);
  }
  for (let i = north; i > south; i -= 0.01) {
    const point = projection.forward(i, east);
    pointsX.push(point[0]);
    pointsY.push(point[1]);
  }
  for (let i = east; i > west; i -= 0.01) {
    const point = projection.forward(south, i);
    pointsX.push(point[0]);
    pointsY.push(point[1]);
  }
  const ls = Math.min(...pointsY);
  const lw = Math.min(...pointsX);
  const ln = Math.max(...pointsY);
  const le = Math.max(...pointsX);
  return [ls, lw, ln, le];
};
const getBorderPoints = (projectionGrid) => {
  const points = [];
  for (let i = 0; i < projectionGrid.ny; i++) {
    points.push([projectionGrid.origin[0], projectionGrid.origin[1] + i * projectionGrid.dy]);
  }
  for (let i = 0; i < projectionGrid.nx; i++) {
    points.push([
      projectionGrid.origin[0] + i * projectionGrid.dx,
      projectionGrid.origin[1] + projectionGrid.ny * projectionGrid.dy
    ]);
  }
  for (let i = projectionGrid.ny; i >= 0; i--) {
    points.push([
      projectionGrid.origin[0] + projectionGrid.nx * projectionGrid.dx,
      projectionGrid.origin[1] + i * projectionGrid.dy
    ]);
  }
  for (let i = projectionGrid.nx; i >= 0; i--) {
    points.push([projectionGrid.origin[0] + i * projectionGrid.dx, projectionGrid.origin[1]]);
  }
  return points;
};
const getBoundsFromGrid = (lonMin, latMin, dx, dy, nx, ny) => {
  const minLon = lonMin;
  const minLat = latMin;
  const maxLon = minLon + dx * nx;
  const maxLat = minLat + dy * ny;
  return [minLon, minLat, maxLon, maxLat];
};
const getBoundsFromBorderPoints = (borderPoints, projection) => {
  let minLon = 180;
  let minLat = 90;
  let maxLon = -180;
  let maxLat = -90;
  for (const borderPoint of borderPoints) {
    const borderPointLatLon = projection.reverse(borderPoint[0], borderPoint[1]);
    if (borderPointLatLon[0] < minLat) {
      minLat = borderPointLatLon[0];
    }
    if (borderPointLatLon[0] > maxLat) {
      maxLat = borderPointLatLon[0];
    }
    if (borderPointLatLon[1] < minLon) {
      minLon = borderPointLatLon[1];
    }
    if (borderPointLatLon[1] > maxLon) {
      maxLon = borderPointLatLon[1];
    }
  }
  return [minLon, minLat, maxLon, maxLat];
};
const getCenterFromBounds = (bounds) => {
  return {
    lng: (bounds[2] - bounds[0]) / 2 + bounds[0],
    lat: (bounds[3] - bounds[1]) / 2 + bounds[1]
  };
};
const getCenterFromGrid = (grid) => {
  return {
    lng: grid.lonMin + grid.dx * (grid.nx * 0.5),
    lat: grid.latMin + grid.dy * (grid.ny * 0.5)
  };
};
const rotatePoint = (cx, cy, theta, x, y) => {
  const xt = Math.cos(theta) * (x - cx) - Math.sin(theta) * (y - cy) + cx;
  const yt = Math.sin(theta) * (x - cx) + Math.cos(theta) * (y - cy) + cy;
  return [xt, yt];
};
export {
  DynamicProjection as D,
  LambertConformalConicProjection as L,
  MercatorProjection as M,
  ProjectionGrid as P,
  RotatedLatLonProjection as R,
  StereograpicProjection as S,
  getBoundsFromBorderPoints as a,
  getCenterFromGrid as b,
  getCenterFromBounds as c,
  getIndicesFromBounds as d,
  getBoundsFromGrid as e,
  fastAtan2 as f,
  getBorderPoints as g,
  getIndexFromLatLong as h,
  LambertAzimuthalEqualAreaProjection as i,
  degreesToRadians as j,
  tile2lat as k,
  lon2tile as l,
  lat2tile as m,
  hermite as n,
  derivative as o,
  getRotatedSWNE as p,
  rotatePoint as q,
  radiansToDegrees as r,
  secondDerivative as s,
  tile2lon as t
};
