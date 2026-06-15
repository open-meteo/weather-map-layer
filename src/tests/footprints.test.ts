import { DOMAIN_FOOTPRINTS, getDomainFootprint } from '../domain-footprints';
import { describe, expect, it } from 'vitest';

describe('DOMAIN_FOOTPRINTS', () => {
	it('exposes the NULL-padded reprojected regular-grid domains', () => {
		expect(getDomainFootprint('dwd_icon_d2')).toBeDefined();
		expect(getDomainFootprint('meteofrance_arome_france0025')).toBeDefined();
	});

	for (const [name, ring] of Object.entries(DOMAIN_FOOTPRINTS)) {
		describe(name, () => {
			it('is a closed ring sampled at high resolution', () => {
				// The arches are fitted curves sampled densely (not a handful of
				// Douglas–Peucker points), so the ring is large.
				expect(ring.length).toBeGreaterThan(100);
				expect(ring[0]).toEqual(ring[ring.length - 1]);
			});

			it('has smooth arches joined by at most two straight sides', () => {
				// Along the north/south arches latitude moves in tiny steps; only the
				// east and west sides make a large vertical jump. A cell staircase or
				// kinked arch would instead produce many large steps.
				let bigLatJumps = 0;
				for (let i = 1; i < ring.length; i++) {
					if (Math.abs(ring[i][1] - ring[i - 1][1]) > 2) bigLatJumps++;
				}
				expect(bigLatJumps).toBeLessThanOrEqual(2);
			});

			it('stays within plausible geographic bounds', () => {
				for (const [lon, lat] of ring) {
					expect(lon).toBeGreaterThanOrEqual(-180);
					expect(lon).toBeLessThanOrEqual(180);
					expect(lat).toBeGreaterThanOrEqual(-90);
					expect(lat).toBeLessThanOrEqual(90);
				}
			});
		});
	}
});
