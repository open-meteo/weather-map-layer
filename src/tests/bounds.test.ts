import {
	checkAgainstBounds,
	constrainBounds,
	currentBounds,
	// setClippingBounds,
	snapBounds,
	updateCurrentBounds
} from '../utils/bounds';
import { afterEach, describe, expect, it } from 'vitest';

import type { Bounds } from '../types';

// Reset module-level state between tests
afterEach(() => {
	// setClippingBounds(undefined);
	updateCurrentBounds([0, 0, 1, 1]); // reset currentBounds to a known value
	// setClippingBounds(undefined); // clear again after updateCurrentBounds
});

describe('snapBounds', () => {
	it('returns snapped bounds that fully contain the viewport', () => {
		const viewport: Bounds = [10, 40, 20, 50];
		const snapped = snapBounds(viewport);

		// Snapped bounds must contain the original viewport
		expect(snapped[0]).toBeLessThanOrEqual(viewport[0]);
		expect(snapped[1]).toBeLessThanOrEqual(viewport[1]);
		expect(snapped[2]).toBeGreaterThanOrEqual(viewport[2]);
		expect(snapped[3]).toBeGreaterThanOrEqual(viewport[3]);
	});

	it('snaps to tile boundaries (values align to tile grid)', () => {
		const viewport: Bounds = [5, 30, 15, 50];
		const snapped = snapBounds(viewport);

		// Result should be aligned; a small pan should produce the same snap
		const slightlyPanned: Bounds = [5.1, 30.1, 15.1, 50.1];
		const snapped2 = snapBounds(slightlyPanned);

		expect(snapped).toEqual(snapped2);
	});

	it('returns [-180, lat, 180, lat] for full-world longitude span', () => {
		const viewport: Bounds = [-180, -60, 180, 60];
		const snapped = snapBounds(viewport);

		expect(snapped[0]).toBe(-180);
		expect(snapped[2]).toBe(180);
	});

	it('returns [-180, lat, 180, lat] for longitude span exceeding 360', () => {
		const viewport: Bounds = [-200, -30, 200, 30];
		const snapped = snapBounds(viewport);

		expect(snapped[0]).toBe(-180);
		expect(snapped[2]).toBe(180);
	});

	it('handles a narrow viewport (high zoom)', () => {
		const viewport: Bounds = [10, 47, 11, 48];
		const snapped = snapBounds(viewport);

		expect(snapped[0]).toBeLessThanOrEqual(10);
		expect(snapped[1]).toBeLessThanOrEqual(47);
		expect(snapped[2]).toBeGreaterThanOrEqual(11);
		expect(snapped[3]).toBeGreaterThanOrEqual(48);
	});

	it('handles bounds crossing the antimeridian', () => {
		const viewport: Bounds = [170, -10, 190, 10];
		const snapped = snapBounds(viewport);

		// Antimeridian-crossing viewports fall back to full-world longitude
		// since a single Bounds tuple cannot represent a wrapped range
		expect(snapped[0]).toBe(-180);
		expect(snapped[2]).toBe(180);
		// Latitude should still be snapped to cover the viewport
		expect(snapped[1]).toBeLessThanOrEqual(-10);
		expect(snapped[3]).toBeGreaterThanOrEqual(10);
	});

	it('returns valid latitude bounds within Mercator limits', () => {
		const viewport: Bounds = [-180, -85, 180, 85];
		const snapped = snapBounds(viewport);

		expect(snapped[1]).toBeGreaterThanOrEqual(-90);
		expect(snapped[3]).toBeLessThanOrEqual(90);
	});

	it('falls back to full-world when tile range covers all tiles', () => {
		// A very wide viewport that spans almost 360 degrees
		const viewport: Bounds = [-170, -40, 170, 40];
		const snapped = snapBounds(viewport);

		// At z=0 (one tile), the tile range covers the full world
		expect(snapped[0]).toBe(-180);
		expect(snapped[2]).toBe(180);
	});
});

// describe('setClippingBounds', () => {
// 	it('sets clipping bounds that updateCurrentBounds uses', () => {
// 		setClippingBounds([0, 0, 50, 50]);
// 		updateCurrentBounds([-10, -10, 60, 60]);

// 		// currentBounds should be constrained to [0, 0, 50, 50]
// 		expect(currentBounds![0]).toBeGreaterThanOrEqual(0);
// 		expect(currentBounds![1]).toBeGreaterThanOrEqual(0);
// 		expect(currentBounds![2]).toBeLessThanOrEqual(50);
// 		expect(currentBounds![3]).toBeLessThanOrEqual(50);
// 	});

// 	it('clears clipping bounds when set to undefined', () => {
// 		setClippingBounds([0, 0, 10, 10]);
// 		setClippingBounds(undefined);
// 		updateCurrentBounds([-50, -50, 50, 50]);

// 		// Without clipping, snapped bounds can exceed [0,0,10,10]
// 		const snapped = snapBounds([-50, -50, 50, 50]);
// 		expect(currentBounds).toEqual(snapped);
// 	});

// 	it('is idempotent for identical bounds', () => {
// 		setClippingBounds([10, 20, 30, 40]);
// 		updateCurrentBounds([0, 0, 50, 50]);
// 		const first = currentBounds;

// 		// Set again with same values — should be a no-op
// 		setClippingBounds([10, 20, 30, 40]);
// 		updateCurrentBounds([0, 0, 50, 50]);
// 		expect(currentBounds).toEqual(first);
// 	});
// });

describe('updateCurrentBounds', () => {
	it('updates the exported currentBounds', () => {
		updateCurrentBounds([5, 10, 15, 20]);
		expect(currentBounds).toBeDefined();
	});

	it('applies snapBounds before setting currentBounds', () => {
		updateCurrentBounds([5, 40, 15, 50]);

		// currentBounds should be the snapped version, not the raw input
		const snapped = snapBounds([5, 40, 15, 50]);
		expect(currentBounds).toEqual(snapped);
	});

	// it('constrains to clipping bounds when set', () => {
	// 	setClippingBounds([0, 0, 20, 60]);
	// 	updateCurrentBounds([-10, 30, 30, 70]);

	// 	expect(currentBounds![0]).toBeGreaterThanOrEqual(0);
	// 	expect(currentBounds![2]).toBeLessThanOrEqual(20);
	// 	expect(currentBounds![3]).toBeLessThanOrEqual(60);
	// });
});

describe('checkAgainstBounds', () => {
	describe('normal range (max >= min)', () => {
		it('returns false when point is within bounds', () => {
			expect(checkAgainstBounds(5, 0, 10)).toBe(false);
		});

		it('returns false when point equals min', () => {
			expect(checkAgainstBounds(0, 0, 10)).toBe(false);
		});

		it('returns false when point equals max', () => {
			expect(checkAgainstBounds(10, 0, 10)).toBe(false);
		});

		it('returns true when point is below min', () => {
			expect(checkAgainstBounds(-1, 0, 10)).toBe(true);
		});

		it('returns true when point is above max', () => {
			expect(checkAgainstBounds(11, 0, 10)).toBe(true);
		});
	});

	describe('wrapped range (max < min, e.g. antimeridian)', () => {
		// When max < min, the valid range wraps: [min..360] ∪ [0..max]
		it('returns false when point is above min', () => {
			expect(checkAgainstBounds(170, 160, 10)).toBe(false);
		});

		it('returns false when point is below max', () => {
			expect(checkAgainstBounds(5, 160, 10)).toBe(false);
		});

		it('returns true when point is in the gap between max and min', () => {
			expect(checkAgainstBounds(50, 160, 10)).toBe(true);
		});

		it('returns false when point equals min', () => {
			expect(checkAgainstBounds(160, 160, 10)).toBe(false);
		});

		it('returns false when point equals max', () => {
			expect(checkAgainstBounds(10, 160, 10)).toBe(false);
		});
	});
});

describe('constrainBounds', () => {
	describe('standard bounds (no dateline crossing)', () => {
		it('should return the same bounds when fully within constrainBounds', () => {
			const bounds: Bounds = [-50, -30, 50, 30];
			const clip: Bounds = [-180, -90, 180, 90];

			expect(constrainBounds(bounds, clip)).toEqual([-50, -30, 50, 30]);
		});

		it('should clip minLon to constrainBounds minLon', () => {
			const bounds: Bounds = [-100, -30, 50, 30];
			const clip: Bounds = [-80, -90, 180, 90];

			expect(constrainBounds(bounds, clip)).toEqual([-80, -30, 50, 30]);
		});

		it('should clip maxLon to constrainBounds maxLon', () => {
			const bounds: Bounds = [-50, -30, 100, 30];
			const clip: Bounds = [-180, -90, 80, 90];

			expect(constrainBounds(bounds, clip)).toEqual([-50, -30, 80, 30]);
		});

		it('should clip minLat to constrainBounds minLat', () => {
			const bounds: Bounds = [-50, -100, 50, 30];
			const clip: Bounds = [-180, -90, 180, 90];

			expect(constrainBounds(bounds, clip)).toEqual([-50, -90, 50, 30]);
		});

		it('should clip maxLat to constrainBounds maxLat', () => {
			const bounds: Bounds = [-50, -30, 50, 100];
			const clip: Bounds = [-180, -90, 180, 90];

			expect(constrainBounds(bounds, clip)).toEqual([-50, -30, 50, 90]);
		});

		it('should clip all values when bounds exceed constrainBounds on all sides', () => {
			const bounds: Bounds = [-100, -50, 100, 50];
			const clip: Bounds = [-80, -40, 80, 40];

			expect(constrainBounds(bounds, clip)).toEqual([-80, -40, 80, 40]);
		});

		it('should return exact constrainBounds when bounds match exactly', () => {
			const bounds: Bounds = [-180, -90, 180, 90];
			const clip: Bounds = [-180, -90, 180, 90];

			expect(constrainBounds(bounds, clip)).toEqual([-180, -90, 180, 90]);
		});

		it('should handle partial overlap', () => {
			const bounds: Bounds = [-100, -50, 50, 30];
			const clip: Bounds = [-80, -40, 80, 40];

			expect(constrainBounds(bounds, clip)).toEqual([-80, -40, 50, 30]);
		});
	});

	describe('dateline crossing clip bounds (clipMinLon > clipMaxLon)', () => {
		it('should preserve dateline-crossing bounds with world clip', () => {
			const bounds: Bounds = [-180, -30, 180, 30];
			const clip: Bounds = [170, -90, -170, 90]; // Crosses dateline: 170°E to 170°W

			expect(constrainBounds(bounds, clip)).toEqual([170, -30, -170, 30]);
		});

		it('should not modify bounds already within dateline-crossing clip', () => {
			const bounds: Bounds = [175, -30, -175, 30];
			const clip: Bounds = [170, -90, -170, 90];

			expect(constrainBounds(bounds, clip)).toEqual([175, -30, -175, 30]);
		});

		it('should clip minLon when in the gap of dateline-crossing clip', () => {
			// minLon 0 is in the "gap" (invalid zone between -170 and 170)
			const bounds: Bounds = [0, -30, -175, 30];
			const clip: Bounds = [170, -90, -170, 90];

			expect(constrainBounds(bounds, clip)).toEqual([170, -30, -175, 30]);
		});

		it('should clip maxLon when in the gap of dateline-crossing clip', () => {
			// maxLon 0 is in the "gap" (invalid zone between -170 and 170)
			const bounds: Bounds = [175, -30, 0, 30];
			const clip: Bounds = [170, -90, -170, 90];

			expect(constrainBounds(bounds, clip)).toEqual([175, -30, -170, 30]);
		});

		it('should return null when bounds do not overlap', () => {
			const bounds: Bounds = [-50, -30, 50, 30];
			const clip: Bounds = [170, -90, -170, 90];

			expect(constrainBounds(bounds, clip)).toEqual(undefined);
		});

		it('should still clip latitude normally with dateline-crossing clip', () => {
			const bounds: Bounds = [175, -100, -175, 100];
			const clip: Bounds = [170, -90, -170, 90];

			expect(constrainBounds(bounds, clip)).toEqual([175, -90, -175, 90]);
		});

		it('should handle narrow dateline-crossing clip bounds', () => {
			const bounds: Bounds = [-180, -45, 180, 45];
			const clip: Bounds = [179, -90, -179, 90]; // Very narrow strip across dateline

			expect(constrainBounds(bounds, clip)).toEqual([179, -45, -179, 45]);
		});
	});

	describe('dateline crossing input bounds (minLon > maxLon)', () => {
		it('should preserve dateline-crossing bounds with world clip', () => {
			const bounds: Bounds = [170, -30, -170, 30]; // Crosses dateline
			const clip: Bounds = [-180, -90, 180, 90];

			expect(constrainBounds(bounds, clip)).toEqual([170, -30, -170, 30]);
		});

		it('should clip dateline-crossing bounds against smaller non-crossing clip', () => {
			const bounds: Bounds = [160, -30, -160, 30]; // Wide dateline crossing
			const clip: Bounds = [170, -90, 180, 90]; // Eastern hemisphere only

			expect(constrainBounds(bounds, clip)).toEqual([170, -30, 180, 30]);
		});

		it('should handle both bounds and clip crossing dateline', () => {
			const bounds: Bounds = [160, -30, -160, 30];
			const clip: Bounds = [170, -90, -170, 90];

			expect(constrainBounds(bounds, clip)).toEqual([170, -30, -170, 30]);
		});
	});

	describe('edge cases', () => {
		it('should handle bounds at exactly the dateline', () => {
			const bounds: Bounds = [180, -30, -180, 30];
			const clip: Bounds = [-180, -90, 180, 90];

			expect(constrainBounds(bounds, clip)).toEqual([180, -30, -180, 30]);
		});

		it('should handle zero-width bounds', () => {
			const bounds: Bounds = [50, -30, 50, 30];
			const clip: Bounds = [-180, -90, 180, 90];

			expect(constrainBounds(bounds, clip)).toEqual([50, -30, 50, 30]);
		});

		it('should handle zero-height bounds', () => {
			const bounds: Bounds = [-50, 0, 50, 0];
			const clip: Bounds = [-180, -90, 180, 90];

			expect(constrainBounds(bounds, clip)).toEqual([-50, 0, 50, 0]);
		});
	});
});
