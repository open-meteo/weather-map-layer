/**
 * GLSL generator for the GPU layer.
 *
 * A fragment shader is assembled per interpolation method: one sampling
 * function over a regular lat/lon grid, specialised at compile time. The math
 * is a direct port of the CPU implementations so both paths produce the same
 * picture:
 *
 * - grid lookup:      grids/regular.ts locate()
 * - interpolation:    grids/interpolations.ts (NaN-aware bilinear, Catmull-Rom
 *                     with overshoot clamp, monotone Hermite)
 * - colour mapping:   utils/styling.ts, baked into a 1D LUT texture (color-lut.ts)
 *
 * Missing data (NaN in the Float32Array) is encoded as a large sentinel value
 * at texture upload time: NaN behaviour in GPU float textures is not reliable
 * across drivers, a `> 1e36` comparison is.
 */
import type { InterpolationMethod } from '../types';

/** Values >= this threshold in the data texture mean "missing" (CPU-side NaN). */
export const MISSING_SENTINEL = 3.0e38;

export interface FragmentShaderSpec {
	interpolation: InterpolationMethod;
}

export const shaderKey = (spec: FragmentShaderSpec): string => spec.interpolation;

/**
 * MapLibre's per-projection shader chunk for custom layers
 * (CustomRenderMethodInput['shaderData']): a vertex prelude declaring
 * `projectTile(vec2 mercator01)` plus the matching defines. Compiled shaders
 * are cached per `variantName` (it changes whenever the prelude does).
 */
export interface ProjectionShaderData {
	variantName: string;
	vertexShaderPrelude: string;
	define: string;
}

/**
 * Vertex shader over the grid's mercator rectangle. The varying carries
 * mercator coordinates of the base world copy (world wrapping only offsets the
 * clip-space position), so the fragment shader always sees continuous
 * longitudes.
 *
 * Positions go through the map's own `projectTile` (mercator, globe and the
 * transition between them); the geometry is therefore a subdivided mesh so it
 * can curve around the sphere.
 */
export const vertexSource = (shaderData: ProjectionShaderData): string => `#version 300 es
${shaderData.vertexShaderPrelude}
${shaderData.define}

in vec2 a_uv;

// Quad corners in mercator [0..1] space: (x0, y0) top-left, (x1, y1) bottom-right.
uniform vec4 u_quad;
// Whole-world offset for antimeridian copies (-1, 0, +1 worlds).
uniform float u_worldOffset;

out vec2 v_mercator;

void main() {
	vec2 pos = mix(u_quad.xy, u_quad.zw, a_uv);
	v_mercator = pos;
	gl_Position = projectTile(vec2(pos.x + u_worldOffset, pos.y));
}
`;

// ─── Shared building blocks ──────────────────────────────────────────────────

const COMMON = `
const float PI = 3.141592653589793;
const float MISSING = 3.0e38;
const float MISSING_THRESHOLD = 1.0e36;

bool isMissing(float v) {
	// Catches the sentinel, infinities and (on drivers that preserve them) NaNs:
	// a NaN comparison is false, so "!(< threshold)" is true for NaN.
	return !(abs(v) < MISSING_THRESHOLD);
}

float readValue(sampler2D tex, int x, int y) {
	return texelFetch(tex, ivec2(x, y), 0).r;
}

// Web-mercator y in [0..1] -> latitude in degrees (utils/math.ts tile2lat at z=0).
float mercToLat(float y) {
	float n = PI - 2.0 * PI * y;
	return degrees(atan(0.5 * (exp(n) - exp(-n))));
}

struct Cell {
	int x;
	int y;
	float xf;
	float yf;
	bool ok;
};

// Rectangular-grid metadata shared by the interpolators.
struct GridMeta {
	ivec2 n;
	bool lonWrap;
};
`;

// NaN-aware bilinear over a possibly-trapezoidal cell — full port of
// interpolations.ts bilinearNaNAware (rectangular grids call it with
// xfLower == xfUpper, collapsing the trapezoid conditions).
const BILINEAR_NAN_AWARE = `
float bilinearNaNAware(float p0, float p1, float p2, float p3, float xfL, float xfU, float yf) {
	float w0 = (1.0 - xfL) * (1.0 - yf);
	float w1 = xfL * (1.0 - yf);
	float w2 = (1.0 - xfU) * yf;
	float w3 = xfU * yf;

	bool n0 = isMissing(p0);
	bool n1 = isMissing(p1);
	bool n2 = isMissing(p2);
	bool n3 = isMissing(p3);

	if (!n0 && !n1 && !n2 && !n3) {
		return p0 * w0 + p1 * w1 + p2 * w2 + p3 * w3;
	}

	// Effective horizontal fraction at the sample's latitude.
	float xf = (1.0 - yf) * xfL + yf * xfU;

	if (n0 && !n1 && !n2 && !n3) {
		if (xfL < xfU || xf + yf < 1.0) return MISSING;
		return (p1 * w1 + p2 * w2 + p3 * w3) / (w1 + w2 + w3);
	}
	if (!n0 && n1 && !n2 && !n3) {
		if (xfL > xfU || xf - yf > 0.0) return MISSING;
		return (p0 * w0 + p2 * w2 + p3 * w3) / (w0 + w2 + w3);
	}
	if (!n0 && !n1 && n2 && !n3) {
		if (xfL > xfU || yf - xf > 0.0) return MISSING;
		return (p0 * w0 + p1 * w1 + p3 * w3) / (w0 + w1 + w3);
	}
	if (!n0 && !n1 && !n2 && n3) {
		if (xfL < xfU || xf + yf > 1.0) return MISSING;
		return (p0 * w0 + p1 * w1 + p2 * w2) / (w0 + w1 + w2);
	}

	return MISSING;
}
`;

const SPLINES = `
float catmullRom1D(float t, float p0, float p1, float p2, float p3) {
	float t2 = t * t;
	float t3 = t2 * t;
	return 0.5 * (-t3 + 2.0 * t2 - t) * p0 +
		0.5 * (3.0 * t3 - 5.0 * t2 + 2.0) * p1 +
		0.5 * (-3.0 * t3 + 4.0 * t2 + t) * p2 +
		0.5 * (t3 - t2) * p3;
}

float monotoneHermite(float t, float p0, float p1, float p2, float p3) {
	float d0 = p1 - p0;
	float d1 = p2 - p1;
	float d2 = p3 - p2;

	float m1 = d0 * d1 <= 0.0 ? 0.0 : (2.0 * d0 * d1) / (d0 + d1);
	float m2 = d1 * d2 <= 0.0 ? 0.0 : (2.0 * d1 * d2) / (d1 + d2);

	float t2 = t * t;
	float t3 = t2 * t;
	return (2.0 * t3 - 3.0 * t2 + 1.0) * p1 + (t3 - 2.0 * t2 + t) * m1 +
		(-2.0 * t3 + 3.0 * t2) * p2 + (t3 - t2) * m2;
}
`;

// Interpolators over a rectangular grid.
const RECT_INTERPOLATORS = `
float interpLinear(sampler2D tex, GridMeta m, Cell c) {
	int x1;
	if (m.lonWrap) {
		x1 = (c.x + 1) % m.n.x;
	} else {
		x1 = c.x + 1;
		if (x1 >= m.n.x) return MISSING; // right border
	}
	if (c.y + 1 >= m.n.y) return MISSING; // bottom border

	float p0 = readValue(tex, c.x, c.y);
	float p1 = readValue(tex, x1, c.y);
	float p2 = readValue(tex, c.x, c.y + 1);
	float p3 = readValue(tex, x1, c.y + 1);
	return bilinearNaNAware(p0, p1, p2, p3, c.xf, c.xf, c.yf);
}

float interpNearest(sampler2D tex, GridMeta m, Cell c) {
	int xi = c.xf >= 0.5 ? c.x + 1 : c.x;
	int yi = c.yf >= 0.5 ? min(c.y + 1, m.n.y - 1) : c.y;
	if (xi >= m.n.x) {
		xi = m.lonWrap ? xi % m.n.x : m.n.x - 1;
	}
	return readValue(tex, xi, yi);
}

// Returns false when the 4x4 stencil is unavailable and the caller must fall
// back to bilinear. Fills the four wrapped/clamped column indices.
bool stencilColumns(GridMeta m, Cell c, out int c0, out int c1, out int c2, out int c3) {
	c0 = 0; c1 = 0; c2 = 0; c3 = 0;
	if (c.y < 1 || c.y >= m.n.y - 2) return false;
	if (m.lonWrap) {
		c0 = (c.x - 1 + m.n.x) % m.n.x;
		c1 = c.x % m.n.x;
		c2 = (c.x + 1) % m.n.x;
		c3 = (c.x + 2) % m.n.x;
		return true;
	}
	if (c.x < 1 || c.x >= m.n.x - 2) return false;
	c0 = c.x - 1;
	c1 = c.x;
	c2 = c.x + 1;
	c3 = c.x + 2;
	return true;
}

float interpCubic(sampler2D tex, GridMeta m, Cell c) {
	int c0, c1, c2, c3;
	if (!stencilColumns(m, c, c0, c1, c2, c3)) return interpLinear(tex, m, c);

	// Catmull-Rom basis weights for the shared x fraction.
	float tx2 = c.xf * c.xf;
	float tx3 = tx2 * c.xf;
	float wx0 = 0.5 * (-tx3 + 2.0 * tx2 - c.xf);
	float wx1 = 0.5 * (3.0 * tx3 - 5.0 * tx2 + 2.0);
	float wx2 = 0.5 * (-3.0 * tx3 + 4.0 * tx2 + c.xf);
	float wx3 = 0.5 * (tx3 - tx2);

	float rows[4];
	float lo = 0.0;
	float hi = 0.0;
	for (int r = 0; r < 4; r++) {
		int yr = c.y - 1 + r;
		float p0 = readValue(tex, c0, yr);
		float p1 = readValue(tex, c1, yr);
		float p2 = readValue(tex, c2, yr);
		float p3 = readValue(tex, c3, yr);
		if (isMissing(p0) || isMissing(p1) || isMissing(p2) || isMissing(p3)) {
			return interpLinear(tex, m, c);
		}
		rows[r] = wx0 * p0 + wx1 * p1 + wx2 * p2 + wx3 * p3;
		// Track the inner 2x2 cell range (rows y and y+1, columns c1/c2) to clamp
		// Catmull-Rom overshoot, exactly like the CPU version.
		if (r == 1) {
			lo = min(p1, p2);
			hi = max(p1, p2);
		} else if (r == 2) {
			lo = min(lo, min(p1, p2));
			hi = max(hi, max(p1, p2));
		}
	}

	float result = catmullRom1D(c.yf, rows[0], rows[1], rows[2], rows[3]);
	return clamp(result, lo, hi);
}

float interpMonotone(sampler2D tex, GridMeta m, Cell c) {
	int c0, c1, c2, c3;
	if (!stencilColumns(m, c, c0, c1, c2, c3)) return interpLinear(tex, m, c);

	float rows[4];
	for (int r = 0; r < 4; r++) {
		int yr = c.y - 1 + r;
		float p0 = readValue(tex, c0, yr);
		float p1 = readValue(tex, c1, yr);
		float p2 = readValue(tex, c2, yr);
		float p3 = readValue(tex, c3, yr);
		if (isMissing(p0) || isMissing(p1) || isMissing(p2) || isMissing(p3)) {
			return interpLinear(tex, m, c);
		}
		rows[r] = monotoneHermite(c.xf, p0, p1, p2, p3);
	}
	return monotoneHermite(c.yf, rows[0], rows[1], rows[2], rows[3]);
}
`;

const INTERP_FN_NAMES: Record<InterpolationMethod, string> = {
	nearest: 'interpNearest',
	linear: 'interpLinear',
	cubic: 'interpCubic',
	monotone: 'interpMonotone'
};

// ─── Grid sampler ────────────────────────────────────────────────────────────

/** Uniform names the generated sampler reads (uploaded by the renderer). */
export const GRID_UNIFORM_NAMES = {
	values: 'u_values',
	n: 'u_n',
	origin: 'u_origin',
	delta: 'u_delta',
	flags: 'u_flags'
} as const;

// Port of RegularGrid.locate() including the ICON "last cell double width"
// hack. flags = (lonWrap, wrapLastCellDouble).
const regularSampler = (interpolation: InterpolationMethod): string => `
uniform sampler2D ${GRID_UNIFORM_NAMES.values};
uniform ivec2 ${GRID_UNIFORM_NAMES.n};
uniform vec2 ${GRID_UNIFORM_NAMES.origin};
uniform vec2 ${GRID_UNIFORM_NAMES.delta};
uniform ivec2 ${GRID_UNIFORM_NAMES.flags};

Cell locate(float lat, float lon) {
	Cell c;
	c.ok = false;
	c.x = 0; c.y = 0; c.xf = 0.0; c.yf = 0.0;

	float xRaw = (lon - u_origin.x) / u_delta.x;
	float yRaw = (lat - u_origin.y) / u_delta.y;

	if (yRaw < 0.0 || yRaw >= float(u_n.y)) return c;
	if (u_flags.x == 0 && (xRaw < 0.0 || xRaw >= float(u_n.x))) return c;
	// Wrap grids: the quad's west edge can land a rounding error west of the
	// origin (negative xRaw); fold it back onto the circle.
	if (u_flags.x == 1) xRaw = mod(xRaw, float(u_n.x));

	float yFloor = floor(yRaw);
	c.y = int(yFloor);
	c.yf = yRaw - yFloor;

	c.x = int(min(floor(xRaw), float(u_n.x) - 1.0));
	float absDx = abs(u_delta.x);
	float effDx = (u_flags.y == 1 && xRaw >= float(u_n.x) - 1.0) ? absDx * 2.0 : absDx;
	// GLSL mod() is always positive for a positive divisor; matches the CPU's
	// abs(remainder) for the in-range longitudes this shader samples.
	c.xf = mod(lon - u_origin.x, effDx) / effDx;
	c.ok = true;
	return c;
}
GridMeta meta() { GridMeta m; m.n = u_n; m.lonWrap = u_flags.x == 1; return m; }

float sampleValue(float lat, float lon) {
	Cell c = locate(lat, lon);
	if (!c.ok) return MISSING;
	return ${INTERP_FN_NAMES[interpolation]}(u_values, meta(), c);
}`;

/** The sampling library: common helpers, interpolators and the grid sampler. */
const samplingSource = (spec: FragmentShaderSpec): string =>
	[
		COMMON,
		BILINEAR_NAN_AWARE,
		SPLINES,
		RECT_INTERPOLATORS,
		regularSampler(spec.interpolation)
	].join('\n');

// ─── Fragment shader assembly ────────────────────────────────────────────────

export const fragmentSource = (spec: FragmentShaderSpec): string => `#version 300 es
precision highp float;
precision highp int;
// Samplers default to lowp in GLSL ES: desktop drivers ignore precision,
// but mobile GPUs honour it and clamp the 3.0e38 missing sentinel read
// from R32F textures to a finite value that then colours as scale min/max.
precision highp sampler2D;
${samplingSource(spec)}

uniform sampler2D u_lut;
// (min, 1 / (max - min), texcoord offset, texcoord scale) — the last two map
// the normalised position onto texel centres of the 1D LUT.
uniform vec4 u_lutRange;
uniform float u_halfQuantum;
uniform float u_opacity;

in vec2 v_mercator;
out vec4 fragColor;

void main() {
	float lat = mercToLat(v_mercator.y);
	// The quad carries natural-direction longitudes, so antimeridian-crossing
	// grids simply exceed 180 degrees here and stay continuous for the grid math.
	float lon = v_mercator.x * 360.0 - 180.0;

	float value = sampleValue(lat, lon);
	if (isMissing(value)) {
		fragColor = vec4(0.0);
		return;
	}

	float t = clamp((value + u_halfQuantum - u_lutRange.x) * u_lutRange.y, 0.0, 1.0);
	vec4 color = texture(u_lut, vec2(u_lutRange.z + t * u_lutRange.w, 0.5));
	float a = color.a * u_opacity;
	// Premultiplied output: matches both MapLibre's custom layer blend state and
	// the default premultiplied WebGL canvas compositing of a WebGL canvas.
	fragColor = vec4(color.rgb * a, a);
}
`;
