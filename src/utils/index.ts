import type { ModelDt, ModelUpdateInterval } from '../types';

export const pad = (n: string | number) => {
	return ('0' + n).slice(-2);
};

export const capitalize = (s: string) => {
	return String(s[0]).toUpperCase() + String(s).slice(1);
};

/**
 * Computes the next/previous/nearest time step for a model domain using UTC.
 * `timeInterval` must be one of:
 * - '15_minute', 'hourly', '3_hourly', '6_hourly', 'weekly_on_monday', 'monthly'
 *
 * @param time - source Date (not mutated)
 * @param timeInterval - the time step type (see above)
 * @param direction - 'forward' | 'backward' | 'nearest' (default 'nearest')
 * @returns a new Date adjusted to the requested domain step (UTC-based)
 * @throws Error on invalid timeInterval
 */
export const domainStep = (
	time: Date,
	timeInterval: ModelDt,
	direction: 'forward' | 'backward' | 'floor' = 'floor'
): Date => {
	const newTime = new Date(time);
	const modifier = direction === 'floor' ? 0 : direction === 'forward' ? 1 : -1;
	switch (timeInterval) {
		case '15_minute':
			newTime.setUTCMinutes(Math.floor(time.getUTCMinutes() / 15) * 15 + modifier * 15);
			break;
		case 'hourly':
			newTime.setUTCHours(time.getUTCHours() + modifier, 0, 0, 0);
			break;
		case '3_hourly':
			newTime.setUTCHours(Math.floor(time.getUTCHours() / 3) * 3 + modifier * 3, 0, 0, 0);
			break;
		case '6_hourly':
			newTime.setUTCHours(Math.floor(time.getUTCHours() / 6) * 6 + modifier * 6, 0, 0, 0);
			break;
		case '12_hourly':
			newTime.setUTCHours(Math.floor(time.getUTCHours() / 12) * 12 + modifier * 12, 0, 0, 0);
			break;
		case 'daily':
			newTime.setUTCDate(time.getUTCDate() + modifier);
			newTime.setUTCHours(0, 0, 0, 0);
			break;
		case 'weekly_on_monday': {
			const dayOfWeek = newTime.getUTCDay();
			const nextMondayInDays = (8 - dayOfWeek) % 7;
			switch (direction) {
				case 'backward':
				case 'floor':
					if (nextMondayInDays === 0 && direction === 'floor') {
						newTime.setUTCDate(time.getUTCDate());
					} else {
						newTime.setUTCDate(time.getUTCDate() + nextMondayInDays - 7);
					}
					break;
				case 'forward':
					if (nextMondayInDays === 0) {
						newTime.setUTCDate(time.getUTCDate() + 7);
					} else {
						newTime.setUTCDate(time.getUTCDate() + nextMondayInDays);
					}
					break;
			}
			newTime.setUTCHours(0, 0, 0, 0);
			break;
		}
		case 'monthly':
			newTime.setUTCMonth(time.getUTCMonth() + modifier);
			newTime.setUTCDate(1);
			newTime.setUTCHours(0, 0, 0, 0);
			break;
		default: {
			// This ensures exhaustiveness checking
			const _exhaustive: never = timeInterval;
			throw new Error(`Invalid time interval: ${timeInterval}`);
		}
	}
	return newTime;
};

/**
 * Get the closest model run time rounded down to the model interval, in UTC.
 * Supported model intervals:
 * - 'hourly', '3_hourly', '6_hourly', '12_hourly', 'daily', 'monthly'
 */
export const closestModelRun = (time: Date, modelInterval: ModelUpdateInterval): Date => {
	const modelDtCompatible: ModelDt = modelInterval;
	return domainStep(time, modelDtCompatible, 'floor');
};
