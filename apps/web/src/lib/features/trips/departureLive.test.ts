import { expect, it } from 'vitest';
import { isBeforeTodaysDeparture } from './departureLive.ts';

it('uses the provider clock and keeps after-midnight timetable hours on their service date', () => {
	const now = new Date('2026-11-27T21:38:15Z');
	const before = (time: string) => isBeforeTodaysDeparture(time, 'America/Toronto', now);

	expect(before('16:38:16')).toBe(true);
	expect(before('16:38:15')).toBe(false);
	expect(before('16:38:14')).toBe(false);
	expect(before('25:10:00')).toBe(true);
});
