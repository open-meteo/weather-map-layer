import { clipBounds } from '../utils/math';
import { describe, expect, it } from 'vitest';

import { Bounds } from '../types';

describe('clipBounds', () => {
	describe('standard bounds (no dateline crossing)', () => {
		it('should return the same bounds when fully within clipBounds', () => {
			const bounds: Bounds = [-50, -30, 50, 30];
			const clip: Bounds = [-180, -90, 180, 90];

			expect(clipBounds(bounds, clip)).toEqual([-50, -30, 50, 30]);
		});

		it('should clip minLon to clipBounds minLon', () => {
			const bounds: Bounds = [-100, -30, 50, 30];
			const clip: Bounds = [-80, -90, 180, 90];

			expect(clipBounds(bounds, clip)).toEqual([-80, -30, 50, 30]);
		});

		it('should clip maxLon to clipBounds maxLon', () => {
			const bounds: Bounds = [-50, -30, 100, 30];
			const clip: Bounds = [-180, -90, 80, 90];

			expect(clipBounds(bounds, clip)).toEqual([-50, -30, 80, 30]);
		});

		it('should clip minLat to clipBounds minLat', () => {
			const bounds: Bounds = [-50, -100, 50, 30];
			const clip: Bounds = [-180, -90, 180, 90];

			expect(clipBounds(bounds, clip)).toEqual([-50, -90, 50, 30]);
		});

		it('should clip maxLat to clipBounds maxLat', () => {
			const bounds: Bounds = [-50, -30, 50, 100];
			const clip: Bounds = [-180, -90, 180, 90];

			expect(clipBounds(bounds, clip)).toEqual([-50, -30, 50, 90]);
		});

		it('should clip all values when bounds exceed clipBounds on all sides', () => {
			const bounds: Bounds = [-100, -50, 100, 50];
			const clip: Bounds = [-80, -40, 80, 40];

			expect(clipBounds(bounds, clip)).toEqual([-80, -40, 80, 40]);
		});

		it('should return exact clipBounds when bounds match exactly', () => {
			const bounds: Bounds = [-180, -90, 180, 90];
			const clip: Bounds = [-180, -90, 180, 90];

			expect(clipBounds(bounds, clip)).toEqual([-180, -90, 180, 90]);
		});

		it('should handle partial overlap', () => {
			const bounds: Bounds = [-100, -50, 50, 30];
			const clip: Bounds = [-80, -40, 80, 40];

			expect(clipBounds(bounds, clip)).toEqual([-80, -40, 50, 30]);
		});
	});

	describe('dateline crossing clip bounds (clipMinLon > clipMaxLon)', () => {
		it('should preserve dateline-crossing bounds with world clip', () => {
			const bounds: Bounds = [-180, -30, 180, 30];
			const clip: Bounds = [170, -90, -170, 90]; // Crosses dateline: 170°E to 170°W

			expect(clipBounds(bounds, clip)).toEqual([170, -30, -170, 30]);
		});

		it('should not modify bounds already within dateline-crossing clip', () => {
			const bounds: Bounds = [175, -30, -175, 30];
			const clip: Bounds = [170, -90, -170, 90];

			expect(clipBounds(bounds, clip)).toEqual([175, -30, -175, 30]);
		});

		it('should clip minLon when in the gap of dateline-crossing clip', () => {
			// minLon 0 is in the "gap" (invalid zone between -170 and 170)
			const bounds: Bounds = [0, -30, -175, 30];
			const clip: Bounds = [170, -90, -170, 90];

			expect(clipBounds(bounds, clip)).toEqual([170, -30, -175, 30]);
		});

		it('should clip maxLon when in the gap of dateline-crossing clip', () => {
			// maxLon 0 is in the "gap" (invalid zone between -170 and 170)
			const bounds: Bounds = [175, -30, 0, 30];
			const clip: Bounds = [170, -90, -170, 90];

			expect(clipBounds(bounds, clip)).toEqual([175, -30, -170, 30]);
		});

		it('should return null when bounds do not overlap', () => {
			const bounds: Bounds = [-50, -30, 50, 30];
			const clip: Bounds = [170, -90, -170, 90];

			expect(clipBounds(bounds, clip)).toEqual(undefined);
		});

		it('should still clip latitude normally with dateline-crossing clip', () => {
			const bounds: Bounds = [175, -100, -175, 100];
			const clip: Bounds = [170, -90, -170, 90];

			expect(clipBounds(bounds, clip)).toEqual([175, -90, -175, 90]);
		});

		it('should handle narrow dateline-crossing clip bounds', () => {
			const bounds: Bounds = [-180, -45, 180, 45];
			const clip: Bounds = [179, -90, -179, 90]; // Very narrow strip across dateline

			expect(clipBounds(bounds, clip)).toEqual([179, -45, -179, 45]);
		});
	});

	describe('dateline crossing input bounds (minLon > maxLon)', () => {
		it('should preserve dateline-crossing bounds with world clip', () => {
			const bounds: Bounds = [170, -30, -170, 30]; // Crosses dateline
			const clip: Bounds = [-180, -90, 180, 90];

			expect(clipBounds(bounds, clip)).toEqual([170, -30, -170, 30]);
		});

		it('should clip dateline-crossing bounds against smaller non-crossing clip', () => {
			const bounds: Bounds = [160, -30, -160, 30]; // Wide dateline crossing
			const clip: Bounds = [170, -90, 180, 90]; // Eastern hemisphere only

			expect(clipBounds(bounds, clip)).toEqual([170, -30, 180, 30]);
		});

		it('should handle both bounds and clip crossing dateline', () => {
			const bounds: Bounds = [160, -30, -160, 30];
			const clip: Bounds = [170, -90, -170, 90];

			expect(clipBounds(bounds, clip)).toEqual([170, -30, -170, 30]);
		});
	});

	describe('edge cases', () => {
		it('should handle bounds at exactly the dateline', () => {
			const bounds: Bounds = [180, -30, -180, 30];
			const clip: Bounds = [-180, -90, 180, 90];

			expect(clipBounds(bounds, clip)).toEqual([180, -30, -180, 30]);
		});

		it('should handle zero-width bounds', () => {
			const bounds: Bounds = [50, -30, 50, 30];
			const clip: Bounds = [-180, -90, 180, 90];

			expect(clipBounds(bounds, clip)).toEqual([50, -30, 50, 30]);
		});

		it('should handle zero-height bounds', () => {
			const bounds: Bounds = [-50, 0, 50, 0];
			const clip: Bounds = [-180, -90, 180, 90];

			expect(clipBounds(bounds, clip)).toEqual([-50, 0, 50, 0]);
		});
	});
});
