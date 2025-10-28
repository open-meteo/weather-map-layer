import { expect, test } from 'vitest';

import { domainOptions } from '../utils/domains';
import { fastAtan2 } from '../utils/math';
import { LambertConformalConicProjection, RotatedLatLonProjection } from '../utils/projections';

const dmiDomain = domainOptions.find((d) => d.value === 'dmi_harmonie_arome_europe');
const knmiDomain = domainOptions.find((d) => d.value === 'knmi_harmonie_arome_europe');

test('Test LambertConformalConicProjection for DMI', () => {
	const proj = new LambertConformalConicProjection(dmiDomain?.grid.projection);
	expect(proj.ρ0).toBe(0.6872809586016131);
	expect(proj.F).toBe(1.801897704650192);
	expect(proj.n).toBe(0.8241261886220157);
	expect(proj.λ0).toBe(-0.13962634015954636);
	expect(proj.R).toBe(6371229);

	expect(proj.forward(39.671, -25.421997)[0]).toBe(-1527524.6244234492);
	expect(proj.forward(39.671, -25.421997)[1]).toBe(-1588681.0428292789);

	expect(proj.reverse(-1527524.6244234492, -1588681.0428292789)[0]).toBe(39.671000000000014);
	expect(proj.reverse(-1527524.6244234492, -1588681.0428292789)[1]).toBe(-25.421996999999998);
});

test('Test RotatedLatLon for KNMI', () => {
	const proj = new RotatedLatLonProjection(knmiDomain?.grid.projection);
	expect(proj.θ).toBe(0.9599310885968813);
	expect(proj.ϕ).toBe(-0.13962634015954636);

	expect(proj.forward(39.671, -25.421997)[0]).toBe(13.716985366241445);
	expect(proj.forward(39.671, -25.421997)[1]).toBe(13.617348599940314);
});

test('fastAtan2 approximates Math.atan2 within 0.00001 radians', () => {
	const steps = 1000;
	let maxError = 0;
	for (let i = 0; i <= steps; ++i) {
		const theta = -Math.PI + (2 * Math.PI * i) / steps;
		// Use a radius to avoid (0,0)
		const r = 1.0;
		const x = r * Math.cos(theta);
		const y = r * Math.sin(theta);

		const approx = fastAtan2(y, x);
		const exact = Math.atan2(y, x);
		const error = Math.abs(approx - exact);

		if (error > maxError) maxError = error;

		expect(error).toBeLessThan(0.00001);
	}
	// special values
	expect(fastAtan2(0, 0)).toBe(0);
	expect(fastAtan2(0, 1)).toBe(0);
	expect(fastAtan2(1, 0)).toBe(Math.PI / 2);
	expect(fastAtan2(0, -1)).toBe(Math.PI);
	expect(fastAtan2(-1, 0)).toBe(-Math.PI / 2);
});
