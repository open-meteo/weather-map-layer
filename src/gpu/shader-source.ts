/**
 * GLSL generator for the GPU render paths.
 *
 * A fragment shader is assembled per render configuration: one *sampling
 * function per layer* (seamless composites have several layers, plain domains
 * exactly one), specialised at compile time for the layer's grid kind
 * (regular / projected / reduced-gaussian) and the interpolation method. The
 * math is a direct port of the CPU implementations so both paths produce the
 * same picture:
 *
 * - grid lookup:      grids/regular.ts locate(), grids/projected.ts
 *                     findPointInterpolated(), grids/gaussian.ts
 * - projections:      grids/projections.ts (forward transforms only)
 * - interpolation:    grids/interpolations.ts (NaN-aware trapezoid bilinear,
 *                     Catmull-Rom with overshoot clamp, monotone Hermite)
 * - seamless blend:   utils/seamless-sampling.ts (smooth-step edge weight over
 *                     domain-boundary distance, refined by a NaN-distance field)
 * - colour mapping:   utils/styling.ts, baked into a 1D LUT texture (color-lut.ts)
 *
 * Missing data (NaN in the Float32Array) is encoded as a large sentinel value
 * at texture upload time: NaN behaviour in GPU float textures is not reliable
 * across drivers, a `> 1e36` comparison is.
 */
import type { InterpolationMethod } from '../types';

/** Values >= this threshold in the data texture mean "missing" (CPU-side NaN). */
export const MISSING_SENTINEL = 3.0e38;

export interface LayerShaderSpec {
	gridKind: 'regular' | 'projected' | 'gaussian';
	projectionName?:
		| 'StereographicProjection'
		| 'RotatedLatLonProjection'
		| 'LambertConformalConicProjection'
		| 'LambertAzimuthalEqualAreaProjection';
	/** Layer blends into the next coarser one across its edge zone. */
	blends?: boolean;
	/** Layer has a NaN-distance texture refining the blend edge. */
	hasNanField?: boolean;
}

export interface FragmentShaderSpec {
	/** Finest-first, at least one. A plain (non-seamless) domain is one layer. */
	layers: LayerShaderSpec[];
	interpolation: InterpolationMethod;
}

export const shaderKey = (spec: FragmentShaderSpec): string =>
	spec.layers
		.map(
			(l) =>
				`${l.gridKind}:${l.projectionName ?? ''}:${l.blends ? 'b' : ''}${l.hasNanField ? 'n' : ''}`
		)
		.join('|') + `|${spec.interpolation}`;

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

const VERTEX_BODY = `
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

/**
 * Vertex shader over the composite's mercator rectangle. The varying carries
 * mercator coordinates of the base world copy (world wrapping only offsets the
 * clip-space position), so the fragment shader always sees continuous
 * longitudes.
 *
 * With MapLibre shaderData, positions go through the map's own `projectTile`
 * (mercator, globe and the transition between them); the geometry must then be
 * a subdivided mesh so it can curve around the sphere. Without it, a plain
 * matrix multiply serves the tile renderer and tests.
 */
export const vertexSource = (shaderData?: ProjectionShaderData): string => {
	if (shaderData) {
		return `#version 300 es
${shaderData.vertexShaderPrelude}
${shaderData.define}
${VERTEX_BODY}`;
	}
	return `#version 300 es
precision highp float;

uniform mat4 u_matrix;

vec4 projectTile(vec2 pos) {
	return u_matrix * vec4(pos, 0.0, 1.0);
}
${VERTEX_BODY}`;
};

/** The prelude-free variant (tile renderer, tests). */
export const VERTEX_SOURCE = vertexSource();

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

// Rectangular-grid metadata shared by the interpolators (regular + projected).
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

// Interpolators over a rectangular (regular/projected) grid.
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

// Reduced-gaussian grid helpers (port of grids/gaussian.ts). The flat value
// array is packed row-major into a 2D texture; g = (latitudeLines, nxStart,
// texWidth, texelCount).
const GAUSSIAN_HELPERS = `
int gaussNxOf(int y, int L) {
	return y < L ? 20 + y * 4 : (2 * L - y - 1) * 4 + 20;
}

int gaussIntegral(int y, int L, int nxStart) {
	int count = 4 * L * (L + 9);
	return y < L
		? 2 * y * y + 18 * y - nxStart
		: count - (2 * (2 * L - y) * (2 * L - y) + 18 * (2 * L - y)) - nxStart;
}

float gaussRead(sampler2D tex, ivec4 g, int idx) {
	if (idx < 0 || idx >= g.w) return MISSING;
	return texelFetch(tex, ivec2(idx % g.z, idx / g.z), 0).r;
}

int modInt(int a, int b) {
	return ((a % b) + b) % b;
}

float gaussSampleLinear(sampler2D tex, ivec4 g, float lat, float lon) {
	int L = g.x;
	int rows = 2 * L;
	float dy = 180.0 / (float(rows) + 0.5);
	float yReal = float(L) - 1.0 - (lat - dy * 0.5) / dy;
	int yLower = modInt(int(floor(yReal)), rows);
	float yf = mod(yReal, 1.0);
	int yUpper = yLower + 1;

	int nxL = gaussNxOf(yLower, L);
	int nxU = gaussNxOf(yUpper, L);
	float dxL = 360.0 / float(nxL);
	float dxU = 360.0 / float(nxU);
	int xL0 = modInt(int(floor(lon / dxL)), nxL);
	int xU0 = modInt(int(floor(lon / dxU)), nxU);
	int iL = gaussIntegral(yLower, L, g.y);
	int iU = gaussIntegral(yUpper, L, g.y);
	float xfL = mod(lon / dxL, 1.0);
	float xfU = mod(lon / dxU, 1.0);

	float p0 = gaussRead(tex, g, iL + xL0);
	float p1 = gaussRead(tex, g, iL + (xL0 + 1) % nxL);
	float p2 = gaussRead(tex, g, iU + xU0);
	float p3 = gaussRead(tex, g, iU + (xU0 + 1) % nxU);
	// Rows differ in longitude points, so the cell is a trapezoid.
	return bilinearNaNAware(p0, p1, p2, p3, xfL, xfU, yf);
}

float gaussSampleNearest(sampler2D tex, ivec4 g, float lat, float lon) {
	int L = g.x;
	int rows = 2 * L;
	float dy = 180.0 / (float(rows) + 0.5);
	int y = modInt(int(floor(float(L) - 1.0 - (lat - dy * 0.5) / dy + 0.5)), rows);
	int nx = gaussNxOf(y, L);
	float dx = 360.0 / float(nx);
	int x = modInt(int(floor(lon / dx + 0.5)), nx);
	return gaussRead(tex, g, gaussIntegral(y, L, g.y) + x);
}

// Interpolate lon within one latitude row using a wrapping 4-point stencil.
// Returns MISSING if any stencil sample is missing; p0/p1 are the bracketing
// raw samples used by the caller's overshoot clamp.
float gaussRowInterp(sampler2D tex, ivec4 g, int y, float lon, bool monotone, out float p0, out float p1) {
	int nx = gaussNxOf(y, g.x);
	float dx = 360.0 / float(nx);
	int x0 = modInt(int(floor(lon / dx)), nx);
	float t = mod(lon / dx, 1.0);
	int base = gaussIntegral(y, g.x, g.y);

	float pm1 = gaussRead(tex, g, base + modInt(x0 - 1, nx));
	p0 = gaussRead(tex, g, base + x0);
	p1 = gaussRead(tex, g, base + (x0 + 1) % nx);
	float p2 = gaussRead(tex, g, base + (x0 + 2) % nx);

	if (isMissing(pm1) || isMissing(p0) || isMissing(p1) || isMissing(p2)) {
		return MISSING;
	}
	return monotone ? monotoneHermite(t, pm1, p0, p1, p2) : catmullRom1D(t, pm1, p0, p1, p2);
}

float gaussSampleCubic(sampler2D tex, ivec4 g, float lat, float lon, bool monotone) {
	int L = g.x;
	int rows = 2 * L;
	float dy = 180.0 / (float(rows) + 0.5);
	float yReal = float(L) - 1.0 - (lat - dy * 0.5) / dy;
	int yLower = int(floor(yReal));
	float yf = yReal - float(yLower);

	// 4-row latitude stencil unavailable near the poles -> bilinear fallback.
	if (yLower < 1 || yLower >= rows - 2) {
		return gaussSampleLinear(tex, g, lat, lon);
	}

	float a0, a1, b0, b1, c0, c1, d0, d1;
	float r0 = gaussRowInterp(tex, g, yLower - 1, lon, monotone, a0, a1);
	float r1 = gaussRowInterp(tex, g, yLower, lon, monotone, b0, b1);
	float r2 = gaussRowInterp(tex, g, yLower + 1, lon, monotone, c0, c1);
	float r3 = gaussRowInterp(tex, g, yLower + 2, lon, monotone, d0, d1);
	if (isMissing(r0) || isMissing(r1) || isMissing(r2) || isMissing(r3)) {
		return gaussSampleLinear(tex, g, lat, lon);
	}

	if (monotone) {
		return monotoneHermite(yf, r0, r1, r2, r3);
	}

	// Clamp Catmull-Rom overshoot to the bracketing samples of the inner cell.
	float result = catmullRom1D(yf, r0, r1, r2, r3);
	float lo = min(min(b0, b1), min(c0, c1));
	float hi = max(max(b0, b1), max(c0, c1));
	return clamp(result, lo, hi);
}
`;

// ─── Projections (forward only; constants precomputed in grid-uniforms.ts) ───

const PROJECTION_BODIES: Record<string, string> = {
	RotatedLatLonProjection: `
	// A = (cosTheta, sinTheta, cosPhi, sinPhi)
	float lonR = radians(lon);
	float latR = radians(lat);
	float clat = cos(latR);
	float x1 = cos(lonR) * clat;
	float y1 = sin(lonR) * clat;
	float z1 = sin(latR);

	float x2 = A.x * A.z * x1 + A.x * A.w * y1 + A.y * z1;
	float y2 = -A.w * x1 + A.z * y1;
	float z2 = -A.y * A.z * x1 - A.y * A.w * y1 + A.x * z1;

	return vec2(-degrees(atan(y2, x2)), -degrees(asin(z2)));
`,
	LambertConformalConicProjection: `
	// A = (lambda0, n, F, rho0), B.x = R
	float phi = radians(lat);
	float lam = radians(lon);
	float theta = A.y * (lam - A.x);
	// tan(pi/4 + phi/2) > 0 for phi in (-90, 90), so pow() is well defined.
	float p = A.z / pow(tan(PI * 0.25 + phi * 0.5), A.y);
	return vec2(B.x * p * sin(theta), B.x * (A.w - p * cos(theta)));
`,
	LambertAzimuthalEqualAreaProjection: `
	// A = (lambda0, sinPhi1, cosPhi1, R)
	float phi = radians(lat);
	float lam = radians(lon);
	float dlam = lam - A.x;
	float k = sqrt(2.0 / (1.0 + A.y * sin(phi) + A.z * cos(phi) * cos(dlam)));
	return vec2(A.w * k * cos(phi) * sin(dlam), A.w * k * (A.z * sin(phi) - A.y * cos(phi) * cos(dlam)));
`,
	StereographicProjection: `
	// A = (lambda0, sinPhi1, cosPhi1, R)
	float phi = radians(lat);
	float lam = radians(lon);
	float dlam = lam - A.x;
	float k = (2.0 * A.w) / (1.0 + A.y * sin(phi) + A.z * cos(phi) * cos(dlam));
	return vec2(k * cos(phi) * sin(dlam), k * (A.z * sin(phi) - A.y * cos(phi) * cos(dlam)));
`
};

const INTERP_FN_NAMES: Record<InterpolationMethod, string> = {
	nearest: 'interpNearest',
	linear: 'interpLinear',
	cubic: 'interpCubic',
	monotone: 'interpMonotone'
};

// ─── Per-layer code generation ───────────────────────────────────────────────

/** Uniform names a layer's generated code uses, in renderer upload order. */
export const layerUniformNames = (
	i: number
): {
	values: string;
	n: string;
	origin: string;
	delta: string;
	flags: string;
	projA: string;
	projB: string;
	gauss: string;
	fullBounds: string;
	edgeProj: string;
	edgeDeg: string;
	blendWidth: string;
	nan: string;
} => ({
	values: `u_values${i}`,
	n: `u_n${i}`,
	origin: `u_origin${i}`,
	delta: `u_delta${i}`,
	flags: `u_flags${i}`,
	projA: `u_projA${i}`,
	projB: `u_projB${i}`,
	gauss: `u_gauss${i}`,
	fullBounds: `u_fullBounds${i}`,
	edgeProj: `u_edgeProj${i}`,
	edgeDeg: `u_edgeDeg${i}`,
	blendWidth: `u_blendWidth${i}`,
	nan: `u_nan${i}`
});

const generateLayer = (
	i: number,
	layer: LayerShaderSpec,
	interpolation: InterpolationMethod
): string => {
	const u = layerUniformNames(i);
	const parts: string[] = [];

	parts.push(`uniform sampler2D ${u.values};`);

	if (layer.gridKind === 'gaussian') {
		// (latitudeLines, nxStart, texWidth, texelCount)
		parts.push(`uniform ivec4 ${u.gauss};`);
		const sampleCall =
			interpolation === 'nearest'
				? `gaussSampleNearest(tex, ${u.gauss}, lat, lon)`
				: interpolation === 'linear'
					? `gaussSampleLinear(tex, ${u.gauss}, lat, lon)`
					: `gaussSampleCubic(tex, ${u.gauss}, lat, lon, ${interpolation === 'monotone'})`;
		parts.push(`
float sampleValue${i}(sampler2D tex, float lat, float lon) {
	return ${sampleCall};
}
float sampleLinear${i}(sampler2D tex, float lat, float lon) {
	return gaussSampleLinear(tex, ${u.gauss}, lat, lon);
}`);
	} else {
		parts.push(`uniform ivec2 ${u.n};`);
		parts.push(`uniform vec2 ${u.origin};`);
		parts.push(`uniform vec2 ${u.delta};`);

		if (layer.gridKind === 'projected') {
			const body = layer.projectionName && PROJECTION_BODIES[layer.projectionName];
			if (!body) {
				throw new Error(`gpu: unsupported projection '${layer.projectionName}'`);
			}
			parts.push(`uniform vec4 ${u.projA};`);
			parts.push(`uniform vec4 ${u.projB};`);
			parts.push(`
vec2 projForward${i}(float lat, float lon) {
	vec4 A = ${u.projA};
	vec4 B = ${u.projB};
${body}}
`);
			// Port of ProjectionGrid.findPointInterpolated().
			parts.push(`
Cell locate${i}(float lat, float lon) {
	Cell c;
	c.ok = false;
	c.x = 0; c.y = 0; c.xf = 0.0; c.yf = 0.0;

	vec2 p = projForward${i}(lat, lon);
	float x = (p.x - ${u.origin}.x) / ${u.delta}.x;
	float y = (p.y - ${u.origin}.y) / ${u.delta}.y;

	if (x < 0.0 || x >= float(${u.n}.x) || y < 0.0 || y >= float(${u.n}.y)) return c;

	float xFloor = floor(x);
	float yFloor = floor(y);
	c.x = int(xFloor);
	c.y = int(yFloor);
	c.xf = x - xFloor;
	c.yf = y - yFloor;
	c.ok = true;
	return c;
}
GridMeta meta${i}() { GridMeta m; m.n = ${u.n}; m.lonWrap = false; return m; }
`);
		} else {
			// Port of RegularGrid.locate() including the ICON "last cell double
			// width" hack. flags = (lonWrap, wrapLastCellDouble).
			parts.push(`uniform ivec2 ${u.flags};`);
			parts.push(`
Cell locate${i}(float lat, float lon) {
	Cell c;
	c.ok = false;
	c.x = 0; c.y = 0; c.xf = 0.0; c.yf = 0.0;

	float xRaw = (lon - ${u.origin}.x) / ${u.delta}.x;
	float yRaw = (lat - ${u.origin}.y) / ${u.delta}.y;

	if (yRaw < 0.0 || yRaw >= float(${u.n}.y)) return c;
	if (${u.flags}.x == 0 && (xRaw < 0.0 || xRaw >= float(${u.n}.x))) return c;

	float yFloor = floor(yRaw);
	c.y = int(yFloor);
	c.yf = yRaw - yFloor;

	c.x = int(min(floor(xRaw), float(${u.n}.x) - 1.0));
	float absDx = abs(${u.delta}.x);
	float effDx = (${u.flags}.y == 1 && xRaw >= float(${u.n}.x) - 1.0) ? absDx * 2.0 : absDx;
	// GLSL mod() is always positive for a positive divisor; matches the CPU's
	// abs(remainder) for the in-range longitudes this shader samples.
	c.xf = mod(lon - ${u.origin}.x, effDx) / effDx;
	c.ok = true;
	return c;
}
GridMeta meta${i}() { GridMeta m; m.n = ${u.n}; m.lonWrap = ${u.flags}.x == 1; return m; }
`);
		}

		parts.push(`
float sampleValue${i}(sampler2D tex, float lat, float lon) {
	Cell c = locate${i}(lat, lon);
	if (!c.ok) return MISSING;
	return ${INTERP_FN_NAMES[interpolation]}(tex, meta${i}(), c);
}
float sampleLinear${i}(sampler2D tex, float lat, float lon) {
	Cell c = locate${i}(lat, lon);
	if (!c.ok) return MISSING;
	return interpLinear(tex, meta${i}(), c);
}`);
	}

	// Edge-blend weight (port of seamless-sampling.ts edgeBlendWeight): 1 deep
	// inside the layer, smooth-stepped to 0 at the edge of its blend zone.
	if (layer.blends) {
		parts.push(`uniform float ${u.blendWidth};`);
		if (layer.hasNanField) {
			parts.push(`uniform sampler2D ${u.nan};`);
		}
		if (layer.gridKind === 'projected') {
			// In projection space the full grid is an axis-aligned rectangle;
			// edgeProj = (minXFull, minYFull, nxFull-1, nyFull-1),
			// edgeDeg = (degPerCol, degPerRow). Port of ProjectionGrid.edgeDistanceDeg.
			parts.push(`uniform vec4 ${u.edgeProj};`);
			parts.push(`uniform vec2 ${u.edgeDeg};`);
			parts.push(`
float edgeDistanceDeg${i}(float lat, float lon) {
	vec2 p = projForward${i}(lat, lon);
	float x = (p.x - ${u.edgeProj}.x) / ${u.delta}.x;
	float y = (p.y - ${u.edgeProj}.y) / ${u.delta}.y;
	float colDist = min(x, ${u.edgeProj}.z - x);
	float rowDist = min(y, ${u.edgeProj}.w - y);
	return min(colDist * ${u.edgeDeg}.x, rowDist * ${u.edgeDeg}.y);
}`);
		} else {
			// Regular/gaussian: distance to the full-domain bounds rectangle.
			parts.push(`uniform vec4 ${u.fullBounds}; // (west, south, east, north)`);
			parts.push(`
float edgeDistanceDeg${i}(float lat, float lon) {
	return min(
		min(lon - ${u.fullBounds}.x, ${u.fullBounds}.z - lon),
		min(lat - ${u.fullBounds}.y, ${u.fullBounds}.w - lat)
	);
}`);
		}
		parts.push(`
float edgeWeight${i}(float lat, float lon) {
	float dist = edgeDistanceDeg${i}(lat, lon);
	${
		layer.hasNanField
			? `float nanDist = sampleLinear${i}(${u.nan}, lat, lon);
	if (!isMissing(nanDist)) dist = min(dist, nanDist);`
			: ''
	}
	float d = dist / ${u.blendWidth};
	if (d <= 0.0) return 0.0;
	if (d >= 1.0) return 1.0;
	return d * d * (3.0 - 2.0 * d); // smooth-step
}`);
	}

	return parts.join('\n');
};

// ─── Fragment shader assembly ────────────────────────────────────────────────

export const fragmentSource = (spec: FragmentShaderSpec): string => {
	const layers = spec.layers;
	if (layers.length === 0) {
		throw new Error('gpu: at least one layer required');
	}
	const single = layers.length === 1;

	const parts: string[] = ['#version 300 es', 'precision highp float;', 'precision highp int;'];
	parts.push(COMMON, BILINEAR_NAN_AWARE, SPLINES);

	if (layers.some((l) => l.gridKind !== 'gaussian')) {
		parts.push(RECT_INTERPOLATORS);
	}
	if (layers.some((l) => l.gridKind === 'gaussian')) {
		parts.push(GAUSSIAN_HELPERS);
	}

	for (let i = 0; i < layers.length; i++) {
		parts.push(generateLayer(i, layers[i], spec.interpolation));
	}

	// Bottom-up unroll of the recursive seamless blend (seamless-sampling.ts
	// blendValue): the coarsest layer seeds the value, each finer layer that
	// covers the point mixes over it with its edge weight. A single plain layer
	// reduces to one sample.
	const blendLines: string[] = [];
	for (let i = layers.length - 1; i >= 0; i--) {
		const weight =
			i === layers.length - 1 || !layers[i].blends ? '1.0' : `edgeWeight${i}(lat, lon)`;
		blendLines.push(`	{
		float v = sampleValue${i}(u_values${i}, lat, lon);
		if (!isMissing(v)) {
			value = isMissing(value) ? v : mix(value, v, ${weight});
		}
	}`);
	}

	// In-shader temporal blend between two timesteps of the same grid; only
	// generated for single-layer configurations.
	const temporal = single
		? `
	if (u_mix < 1.0) {
		float vPrev = sampleValue0(u_valuesPrev, lat, lon);
		if (!isMissing(value) && !isMissing(vPrev)) {
			value = mix(vPrev, value, u_mix);
		} else if (isMissing(value)) {
			value = vPrev;
		}
	}`
		: '';

	parts.push(`
${single ? 'uniform sampler2D u_valuesPrev;\nuniform float u_mix; // 0 = previous, 1 = current' : ''}

uniform sampler2D u_lut;
// (min, 1 / (max - min), texcoord offset, texcoord scale) — the last two map
// the normalised position onto texel centres of the 1D LUT.
uniform vec4 u_lutRange;
uniform float u_halfQuantum;
uniform float u_opacity;
// Optional geographic clip: (west, south, east, north); disabled = +-1e9.
uniform vec4 u_clipBounds;

in vec2 v_mercator;
out vec4 fragColor;

void main() {
	float lat = mercToLat(v_mercator.y);
	// The quad carries natural-direction longitudes, so antimeridian-crossing
	// grids simply exceed 180 degrees here and stay continuous for the grid math.
	float lon = v_mercator.x * 360.0 - 180.0;

	if (lat < u_clipBounds.y || lat > u_clipBounds.w ||
		lon < u_clipBounds.x || lon > u_clipBounds.z) {
		fragColor = vec4(0.0);
		return;
	}

	float value = MISSING;
${blendLines.join('\n')}
${temporal}
	if (isMissing(value)) {
		fragColor = vec4(0.0);
		return;
	}

	float t = clamp((value + u_halfQuantum - u_lutRange.x) * u_lutRange.y, 0.0, 1.0);
	vec4 color = texture(u_lut, vec2(u_lutRange.z + t * u_lutRange.w, 0.5));
	float a = color.a * u_opacity;
	// Premultiplied output: matches both MapLibre's custom layer blend state and
	// the default premultiplied WebGL canvas compositing of the tile renderer.
	fragColor = vec4(color.rgb * a, a);
}`);

	return parts.join('\n');
};
