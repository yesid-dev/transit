import { describe, expect, it } from 'vitest';
import type { StopDailyPoint } from '#lib/v1/index.ts';
import { selectDayByDay } from './dailyTrend';
import { dayByDayDates, dayByDayScope, dayByDaySummary, longDay } from './dayByDayText';

const day = (date: string, readings: number, late: number): StopDailyPoint => ({
	date,
	observation_count: readings,
	severe_count: late,
	severe_pct: null,
});
const RECORD = { from: '2026-11-04', to: '2026-11-10' };
const WEEK = [
	day('2026-11-04', 7, 4),
	day('2026-11-05', 80, 1),
	day('2026-11-06', 1400, 3),
	day('2026-11-08', 35, 0),
	day('2026-11-09', 35, 32),
	day('2026-11-10', 12, 3),
];
const record = selectDayByDay(WEEK, { chosen: null, record: RECORD });

describe('Day by day in words', () => {
	it('names the days, the spread and the highest day', () => {
		expect(dayByDayDates(record, 'en')).toBe('November 4 to 10, 2026');
		expect(dayByDayDates(record, 'fr')).toBe('du 4 au 10 novembre 2026');
		expect(dayByDaySummary(record, 'en')).toBe(
			'Between 0% and 91.4% a day. Highest on Monday, November 9.',
		);
		expect(dayByDaySummary(record, 'fr')).toBe(
			'Entre 0 % et 91,4 % selon le jour. Le plus élevé : lundi 9 novembre.',
		);
		expect(longDay('2026-11-01', 'fr')).toBe('dimanche 1er novembre');
	});

	it('states the limits of the record week: its basis, its gap and its readings', () => {
		expect(dayByDayScope(record, 'en')).toEqual([
			'The same 7 days as the record above. The record adds up their readings; it does not average these daily shares.',
			'1 of these 7 days has no published share. It is a gap, not a zero.',
			'Between 7 and 1,400 readings a day. A day with few readings can swing widely.',
		]);
		expect(dayByDayScope(record, 'fr')).toEqual([
			'Les 7 mêmes jours que le bilan ci-dessus. Le bilan additionne leurs relevés; il ne fait pas la moyenne de ces parts quotidiennes.',
			'1 de ces 7 jours n’a pas de part publiée. C’est une lacune, pas un zéro.',
			'Entre 7 et 1 400 relevés par jour. Une journée avec peu de relevés peut varier fortement.',
		]);
	});

	it('says when the visitor chose the dates and when every day is measured', () => {
		const chosen = selectDayByDay(WEEK, {
			chosen: { from: '2026-11-04', to: '2026-11-05' },
			record: RECORD,
		});
		expect(dayByDayDates(chosen, 'en')).toBe('November 4 to 5, 2026');
		expect(dayByDayScope(chosen, 'en')).toEqual([
			'The dates you chose. The record above stays the published week.',
			'Every day has a published share.',
			'Between 7 and 80 readings a day. A day with few readings can swing widely.',
		]);
	});

	it('falls back to the file’s latest days, and says so', () => {
		const latest = selectDayByDay(WEEK, { chosen: null, record: null });
		expect(dayByDayScope(latest, 'en')[0]).toBe('The latest 7 days in this stop’s file.');
		expect(dayByDayScope(latest, 'fr')[0]).toBe('Les 7 derniers jours du fichier de cet arrêt.');
	});

	it('handles one day, plural gaps, equal readings and no comparison', () => {
		const one = selectDayByDay([day('2026-11-04', 1, 0)], {
			chosen: null,
			record: { from: '2026-11-04', to: '2026-11-04' },
		});
		expect(dayByDayDates(one, 'en')).toBe('November 4, 2026');
		expect(dayByDayDates(one, 'fr')).toBe('4 novembre 2026');
		expect(dayByDaySummary(one, 'en')).toBe(
			'Fewer than 2 measured days: no day-by-day comparison.',
		);
		expect(dayByDayScope(one, 'en')[2]).toBe('1 reading each day.');
		const sparse = selectDayByDay([day('2026-11-04', 5, 1), day('2026-11-10', 5, 2)], {
			chosen: null,
			record: RECORD,
		});
		expect(dayByDayScope(sparse, 'en').slice(1)).toEqual([
			'5 of these 7 days have no published share. They are gaps, not zeros.',
			'5 readings each day.',
		]);
		expect(dayByDayScope(sparse, 'fr')[1]).toBe(
			'5 de ces 7 jours n’ont pas de part publiée. Ce sont des lacunes, pas des zéros.',
		);
	});

	it('names dates across months and years', () => {
		const cross = selectDayByDay([], {
			chosen: { from: '2026-12-29', to: '2027-01-02' },
			record: null,
		});
		expect(dayByDayDates(cross, 'en')).toBe('December 29, 2026 to January 2, 2027');
		expect(dayByDayDates(cross, 'fr')).toBe('du 29 décembre 2026 au 2 janvier 2027');
		// No measured day: no readings sentence.
		expect(dayByDayScope(cross, 'en')).toHaveLength(2);
	});
});
