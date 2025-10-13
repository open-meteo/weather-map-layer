import { expect, test } from 'vitest';
import { RotatedLatLonProjection, LambertConformalConicProjection } from '../utils/projections';

import { domainOptions } from '../utils/domains';

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
