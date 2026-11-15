import { describe, it, expect } from 'vitest';
import type { StopDailyPoint } from '#lib/v1/index.ts';
import { selectDayByDay } from './dailyTrend';

const day = (
	date: string,
	readings: number,
	late: number,
	published: number | null = null,
): StopDailyPoint => ({
	date,
	observation_count: readings,
	severe_count: late,
	severe_pct: published,
	avg_delay_min: null,
});

const RECORD_WEEK = { from: '2026-11-04', to: '2026-11-10' };

/** A real-sized week: one day missing from the file, one day with readings but no late one. */
const WEEK: StopDailyPoint[] = [
	day('2026-11-03', 50, 50, 100), // outside the record week
	day('2026-11-04', 7, 4, 57.1),
	day('2026-11-05', 80, 1, 1.3),
	day('2026-11-06', 400, 3, 0.8),
	day('2026-11-08', 35, 0, 0),
	day('2026-11-09', 35, 32, 91.4),
	day('2026-11-10', 12, 3, 25),
];

describe('selectDayByDay: the days of the record', () => {
	it('draws every day of the record week, a missing day as a gap and never a zero', () => {
		const view = selectDayByDay(WEEK, { chosen: null, record: RECORD_WEEK });
		expect(view.basis).toBe('record');
		expect([view.from, view.to]).toEqual(['2026-11-04', '2026-11-10']);
		expect(view.rows.map((row) => [row.date, row.percent, row.readings, row.lateReadings])).toEqual(
			[
				['2026-11-04', 57.1, 7, 4],
				['2026-11-05', 1.3, 80, 1],
				['2026-11-06', 0.8, 400, 3],
				['2026-11-07', null, null, null],
				['2026-11-08', 0, 35, 0],
				['2026-11-09', 91.4, 35, 32],
				['2026-11-10', 25, 12, 3],
			],
		);
		expect(view.rows[3].gap).toBe('not-published');
		expect(view.measuredDays).toBe(6);
		expect(view.gapDays).toBe(1);
		expect([view.fewestReadings, view.mostReadings]).toEqual([7, 400]);
		expect(view.low).toEqual({ date: '2026-11-08', percent: 0 });
		expect(view.high).toEqual({ date: '2026-11-09', percent: 91.4 });
	});

	it('keeps a day without readings as its own gap, not a 0% day', () => {
		const view = selectDayByDay([day('2026-11-04', 0, 0, null), day('2026-11-05', 9, 3, 33.3)], {
			chosen: null,
			record: { from: '2026-11-04', to: '2026-11-05' },
		});
		expect(view.rows[0]).toEqual({
			date: '2026-11-04',
			percent: null,
			readings: null,
			lateReadings: null,
			gap: 'no-readings',
		});
		expect(view.measuredDays).toBe(1);
		// One measured day is not a comparison.
		expect(view.low).toBeNull();
		expect(view.high).toBeNull();
	});

	it('refuses a day whose counts or published share break the definition', () => {
		const view = selectDayByDay(
			[
				day('2026-11-04', 80, 1, 50), // published share disagrees with 1 of 80
				day('2026-11-05', 10, 11, null), // more late readings than readings
				day('2026-11-06', 10.5, 1, null), // not a whole count
				day('2026-11-07', 10, -1, null), // negative count
				day('2026-11-08', 10, 1, 120), // share out of bounds
				day('2026-11-09', 10, 1, Number.NaN),
				day('2026-11-10', 10, 1, 10),
			],
			{ chosen: null, record: RECORD_WEEK },
		);
		expect(view.rows.map((row) => row.percent)).toEqual([null, null, null, null, null, null, 10]);
		expect(view.rows.slice(0, 6).every((row) => row.gap === 'not-published')).toBe(true);
		expect(view.rows.slice(0, 6).every((row) => row.readings === null)).toBe(true);
	});

	it('derives the share from the counts when the file publishes none', () => {
		const view = selectDayByDay([day('2026-11-04', 3, 1, null)], {
			chosen: null,
			record: { from: '2026-11-04', to: '2026-11-04' },
		});
		expect(view.rows[0].percent).toBe(33.3);
	});
});

describe('selectDayByDay: which days', () => {
	it('shows the dates the visitor chose before the record week', () => {
		const view = selectDayByDay(WEEK, {
			chosen: { from: '2026-11-03', to: '2026-11-05' },
			record: RECORD_WEEK,
		});
		expect(view.basis).toBe('chosen');
		expect(view.rows.map((row) => [row.date, row.percent])).toEqual([
			['2026-11-03', 100],
			['2026-11-04', 57.1],
			['2026-11-05', 1.3],
		]);
	});

	it('falls back to the latest seven calendar days of the file without a record week', () => {
		const view = selectDayByDay(WEEK, { chosen: null, record: null });
		expect(view.basis).toBe('latest');
		expect([view.from, view.to]).toEqual(['2026-11-04', '2026-11-10']);
		expect(view.rows).toHaveLength(7);
	});

	it('crosses a month end with calendar days', () => {
		const view = selectDayByDay([day('2026-12-02', 4, 1, 25)], { chosen: null, record: null });
		expect(view.rows.map((row) => row.date)).toEqual([
			'2026-11-26',
			'2026-11-27',
			'2026-11-28',
			'2026-11-29',
			'2026-11-30',
			'2026-12-01',
			'2026-12-02',
		]);
	});

	it('has no days and no basis without a file or a window', () => {
		const view = selectDayByDay(null, { chosen: null, record: null });
		expect(view).toMatchObject({
			basis: null,
			from: null,
			to: null,
			rows: [],
			measuredDays: 0,
			gapDays: 0,
			fewestReadings: null,
			mostReadings: null,
			low: null,
			high: null,
		});
	});

	it('draws no days for a reversed or malformed window', () => {
		expect(
			selectDayByDay(WEEK, { chosen: { from: '2026-11-10', to: '2026-11-04' }, record: null }).rows,
		).toEqual([]);
		expect(
			selectDayByDay(WEEK, { chosen: { from: 'not-a-day', to: '2026-11-04' }, record: null }).rows,
		).toEqual([]);
	});

	it('names the earliest day when two days share the extreme', () => {
		const view = selectDayByDay(
			[day('2026-11-04', 10, 5, 50), day('2026-11-05', 4, 2, 50), day('2026-11-06', 10, 1, 10)],
			{ chosen: null, record: { from: '2026-11-04', to: '2026-11-06' } },
		);
		expect(view.high).toEqual({ date: '2026-11-04', percent: 50 });
		expect(view.low).toEqual({ date: '2026-11-06', percent: 10 });
	});
});

/** Owner ruling 6: every share is late over readings, in tenths rounded half up, from integers. */
describe('selectDayByDay: math from the definition', () => {
	// Small deterministic generator (mulberry32) so the sweep is the same on every run.
	function seeded(seed: number) {
		let state = seed >>> 0;
		return () => {
			state = (state + 0x6d2b79f5) >>> 0;
			let t = state;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}
	// Independent reference: floor((2000 · late + readings) / (2 · readings)) tenths, half up.
	const referenceTenths = (late: number, readings: number) =>
		Number((2000n * BigInt(late) + BigInt(readings)) / (2n * BigInt(readings)));

	it('agrees with the reference on 300 generated days and keeps every invariant', () => {
		const random = seeded(4511);
		const start = Date.parse('2026-01-01T00:00:00Z');
		const daily = Array.from({ length: 300 }, (_, index) => {
			const readings = 1 + Math.floor(random() * (random() < 0.3 ? 40 : 5000));
			const late = Math.floor(random() * (readings + 1));
			const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
			return day(date, readings, late, referenceTenths(late, readings) / 10);
		});
		const view = selectDayByDay(daily, {
			chosen: { from: daily[0].date, to: daily[299].date },
			record: null,
		});
		expect(view.rows).toHaveLength(300);
		expect(view.measuredDays + view.gapDays).toBe(view.rows.length);
		expect(view.gapDays).toBe(0);
		view.rows.forEach((row, index) => {
			const source = daily[index];
			expect(row.date).toBe(source.date);
			expect(row.readings).toBe(source.observation_count);
			expect(row.lateReadings).toBe(source.severe_count);
			expect(row.lateReadings!).toBeLessThanOrEqual(row.readings!);
			expect(Math.round(row.percent! * 10)).toBe(
				referenceTenths(source.severe_count, source.observation_count),
			);
			expect(Number.isFinite(row.percent)).toBe(true);
			expect(row.percent!).toBeGreaterThanOrEqual(0);
			expect(row.percent!).toBeLessThanOrEqual(100);
			expect(Object.is(row.percent, -0)).toBe(false);
		});
		const percents = view.rows.map((row) => row.percent!);
		expect(view.low!.percent).toBe(Math.min(...percents));
		expect(view.high!.percent).toBe(Math.max(...percents));
		const readings = view.rows.map((row) => row.readings!);
		expect(view.fewestReadings).toBe(Math.min(...readings));
		expect(view.mostReadings).toBe(Math.max(...readings));
	});

	it('rounds the exact half steps up: 1 of 80, 1 of 40, 7 of 2000', () => {
		const view = selectDayByDay(
			[
				day('2026-11-04', 80, 1, 1.3),
				day('2026-11-05', 40, 1, 2.5),
				day('2026-11-06', 2000, 7, 0.4),
			],
			{ chosen: null, record: { from: '2026-11-04', to: '2026-11-06' } },
		);
		expect(view.rows.map((row) => row.percent)).toEqual([1.3, 2.5, 0.4]);
	});
});
