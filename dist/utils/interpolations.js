const noInterpolation = (values, index) => {
  return Number(values[index]);
};
const interpolateLinear = (values, index, xFraction, yFraction, ranges) => {
  const nx = ranges[1]["end"] - ranges[1]["start"];
  const p0 = Number(values[index]);
  let p1 = Number(values[index + 1]);
  const p2 = Number(values[index + nx]);
  let p3 = Number(values[index + 1 + nx]);
  if ((index + 1) % nx == 0) {
    p1 = p0;
    p3 = p0;
  }
  return p0 * (1 - xFraction) * (1 - yFraction) + p1 * xFraction * (1 - yFraction) + p2 * (1 - xFraction) * yFraction + p3 * xFraction * yFraction;
};
const cardinalSpline = (t, p0, p1, p2, p3, tension) => {
  const t2 = t * t;
  const t3 = t2 * t;
  const s = (1 - tension) / 2;
  return s * (-t3 + 2 * t2 - t) * p0 + s * (-t3 + t2) * p1 + (2 * t3 - 3 * t2 + 1) * p1 + s * (t3 - 2 * t2 + t) * p2 + (-2 * t3 + 3 * t2) * p2 + s * (t3 - t2) * p3;
};
const interpolateCardinal2D = (values, nx, index, xFraction, yFraction, tension = 0) => {
  const r0 = cardinalSpline(
    xFraction,
    Number(values[index + -1 * nx - 1]),
    Number(values[index + -1 * nx + 0]),
    Number(values[index + -1 * nx + 1]),
    Number(values[index + -1 * nx + 2]),
    tension
  );
  const r1 = cardinalSpline(
    xFraction,
    Number(values[index + 0 * nx - 1]),
    Number(values[index + 0 * nx + 0]),
    Number(values[index + 0 * nx + 1]),
    Number(values[index + 0 * nx + 2]),
    tension
  );
  const r2 = cardinalSpline(
    xFraction,
    Number(values[index + 1 * nx - 1]),
    Number(values[index + 1 * nx + 0]),
    Number(values[index + 1 * nx + 1]),
    Number(values[index + 1 * nx + 2]),
    tension
  );
  const r3 = cardinalSpline(
    xFraction,
    Number(values[index + 2 * nx - 1]),
    Number(values[index + 2 * nx + 0]),
    Number(values[index + 2 * nx + 1]),
    Number(values[index + 2 * nx + 2]),
    tension
  );
  return cardinalSpline(yFraction, r0, r1, r2, r3, tension);
};
const interpolate2DHermite = (values, index, xFraction, yFraction, ranges) => {
  const nx = ranges[1]["end"] - ranges[1]["start"];
  return interpolateCardinal2D(values, nx, index, xFraction, yFraction, 0.3);
};
export {
  interpolate2DHermite,
  interpolateCardinal2D,
  interpolateLinear,
  noInterpolation
};
