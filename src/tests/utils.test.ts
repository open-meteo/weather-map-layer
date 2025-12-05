import { closestModelRun, domainStep } from '../utils';
import { fastAtan2 } from '../utils/math';
import { describe, expect, test } from 'vitest';

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

describe('domainStep', () => {
	test('hourly nearest does not leave time unchanged', () => {
		const t = new Date(Date.UTC(2024, 0, 1, 5, 10, 20));
		const out = domainStep(t, 'hourly', 'floor');
		expect(out.toISOString()).toBe('2024-01-01T05:00:00.000Z');
	});

	test('hourly forward increments hour', () => {
		const t = new Date(Date.UTC(2024, 0, 1, 23, 0, 0));
		const out = domainStep(t, 'hourly', 'forward');
		expect(out.toISOString()).toBe('2024-01-02T00:00:00.000Z');
	});

	test('3_hourly rounds to multiples of 3', () => {
		const t = new Date(Date.UTC(2024, 0, 1, 5, 0, 0));
		expect(domainStep(t, '3_hourly', 'floor').getUTCHours() % 3).toBe(0);
	});

	test('weekly_on_monday behavior on Monday for directions', () => {
		// Monday 2025-12-01 (UTC) 12:00
		const monday = new Date(Date.UTC(2025, 11, 1, 12));
		const tuesday = new Date(Date.UTC(2025, 11, 2, 12));

		const flooredMonday = domainStep(monday, 'weekly_on_monday', 'floor');
		expect(flooredMonday.toISOString()).toBe('2025-12-01T00:00:00.000Z');
		const flooredTuesday = domainStep(tuesday, 'weekly_on_monday', 'floor');
		expect(flooredTuesday.toISOString()).toBe('2025-12-01T00:00:00.000Z');

		// forward from Monday should give next Monday
		const forwardMonday = domainStep(monday, 'weekly_on_monday', 'forward');
		expect(forwardMonday.toISOString()).toBe('2025-12-08T00:00:00.000Z');
		const forwardTuesday = domainStep(tuesday, 'weekly_on_monday', 'forward');
		expect(forwardTuesday.toISOString()).toBe('2025-12-08T00:00:00.000Z');

		// backward from Monday -> previous Monday
		const backwardMonday = domainStep(monday, 'weekly_on_monday', 'backward');
		expect(backwardMonday.toISOString()).toBe('2025-11-24T00:00:00.000Z');
		const backwardTuesday = domainStep(tuesday, 'weekly_on_monday', 'backward');
		expect(backwardTuesday.toISOString()).toBe('2025-12-01T00:00:00.000Z');
	});

	test('monthly forward across month length boundaries (Jan 31 -> behaviour is JS Date overflow)', () => {
		const t = new Date(Date.UTC(2024, 0, 31, 10));
		const out = domainStep(t, 'monthly', 'forward');
		expect(out.toISOString()).toBe('2024-03-01T00:00:00.000Z');
	});

	test('throws on invalid interval', () => {
		// @ts-expect-error: invalid interval throws
		expect(() => domainStep(new Date(), 'not_a_interval')).toThrow();
	});
});

describe('closestModelRun', () => {
	test('hourly truncates minutes/seconds', () => {
		const t = new Date(Date.UTC(2024, 0, 1, 5, 30, 45, 123));
		const out = closestModelRun(t, 'hourly');
		expect(out.toISOString()).toBe('2024-01-01T05:00:00.000Z');
	});

	test('3_hourly rounds down', () => {
		const t = new Date(Date.UTC(2024, 0, 1, 5, 30));
		const out = closestModelRun(t, '3_hourly');
		expect(out.toISOString()).toBe('2024-01-01T03:00:00.000Z');
	});

	test('daily returns midnight UTC', () => {
		const t = new Date(Date.UTC(2024, 0, 2, 13));
		const out = closestModelRun(t, 'daily');
		expect(out.toISOString()).toBe('2024-01-02T00:00:00.000Z');
	});

	test('monthly sets day to 1', () => {
		const t = new Date(Date.UTC(2024, 6, 15, 9));
		const out = closestModelRun(t, 'monthly');
		expect(out.toISOString()).toBe('2024-07-01T00:00:00.000Z');
	});

	test('throws on invalid model interval', () => {
		// @ts-expect-error: invalid interval throws
		expect(() => closestModelRun(new Date(), 'invalid')).toThrow();
	});

	test('does not mutate original date', () => {
		const t = new Date(Date.UTC(2024, 0, 1, 5, 30));
		const copy = new Date(t);
		closestModelRun(t, '3_hourly');
		expect(t.getTime()).toBe(copy.getTime());
	});
});
