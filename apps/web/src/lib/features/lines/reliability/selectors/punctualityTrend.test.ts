import { describe, expect, it } from 'vitest';
import type { ReliabilityPeriod } from '#lib/v1/index.ts';
import { selectDailyOnTime } from './punctualityTrend';

const day = (date: string, extra: Partial<ReliabilityPeriod>): ReliabilityPeriod =>
	({ grain: 'day', date, ...extra }) as ReliabilityPeriod;

const counted = (date: string, onTime: number, readings: number, avg = 2.5) =>
	day(date, { on_time: onTime, observation_count: readings, avg_delay_min: avg });

describe('selectDailyOnTime', () => {
	it('gives one on-time share per day from its own counts, to one decimal', () => {
		const result = selectDailyOnTime([
			counted('2026-11-04', 700, 1000),
			counted('2026-11-05', 717, 1000),
			counted('2026-11-06', 1, 8, 4.25),
		]);
		expect(result.rows).toEqual([
			{ date: '2026-11-04', percent: 70, readings: 1000, avgDelayMin: 2.5 },
			{ date: '2026-11-05', percent: 71.7, readings: 1000, avgDelayMin: 2.5 },
			// 1 / 8 = 12.5% exactly; 4.25 minutes rounds half away from zero.
			{ date: '2026-11-06', percent: 12.5, readings: 8, avgDelayMin: 4.3 },
		]);
	});

	it('names the lowest and highest days, the earliest on a tie', () => {
		const result = selectDailyOnTime([
			counted('2026-11-04', 70, 100),
			counted('2026-11-05', 648, 1000),
			counted('2026-11-06', 79, 100),
			counted('2026-11-07', 648, 1000),
		]);
		expect(result.low).toEqual({ date: '2026-11-05', percent: 64.8 });
		expect(result.high).toEqual({ date: '2026-11-06', percent: 79 });
	});

	it('keeps only the days inside a chosen window', () => {
		const result = selectDailyOnTime(
			[
				counted('2026-11-03', 50, 100),
				counted('2026-11-04', 70, 100),
				counted('2026-11-05', 80, 100),
			],
			{ from: '2026-11-04', to: '2026-11-05' },
		);
		expect(result.rows.map((row) => row.date)).toEqual(['2026-11-04', '2026-11-05']);
	});

	it('shows a gap, never a zero, for a day whose counts break their definition', () => {
		const result = selectDailyOnTime([
			counted('2026-11-04', 120, 100),
			day('2026-11-05', { otp_pct: 81.25, avg_delay_min: -0.04 }),
			day('2026-11-06', { avg_delay_min: 3 }),
		]);
		expect(result.rows).toEqual([
			{ date: '2026-11-04', percent: null, readings: null, avgDelayMin: 2.5 },
			{ date: '2026-11-05', percent: 81.3, readings: null, avgDelayMin: 0 },
			{ date: '2026-11-06', percent: null, readings: null, avgDelayMin: 3 },
		]);
		expect(Object.is(result.rows[1].avgDelayMin, -0)).toBe(false);
	});

	it('draws every day of the window, with a gap for a day the record does not publish', () => {
		const result = selectDailyOnTime(
			[counted('2026-11-04', 70, 100), counted('2026-11-06', 80, 100)],
			{ from: '2026-11-03', to: '2026-11-06' },
		);
		expect(result.rows).toEqual([
			{ date: '2026-11-03', percent: null, readings: null, avgDelayMin: null },
			{ date: '2026-11-04', percent: 70, readings: 100, avgDelayMin: 2.5 },
			{ date: '2026-11-05', percent: null, readings: null, avgDelayMin: null },
			{ date: '2026-11-06', percent: 80, readings: 100, avgDelayMin: 2.5 },
		]);
	});

	it('keeps a day’s published share when only its reading count is published', () => {
		const [row] = selectDailyOnTime([
			day('2026-11-04', { observation_count: 12, otp_pct: 20.04, avg_delay_min: 3 }),
		]).rows;
		expect(row).toEqual({ date: '2026-11-04', percent: 20, readings: 12, avgDelayMin: 3 });
	});

	it('shows no average delay for a day with zero readings', () => {
		const [row] = selectDailyOnTime([
			day('2026-11-04', { on_time: 0, observation_count: 0, otp_pct: 0, avg_delay_min: 0 }),
		]).rows;
		expect(row).toEqual({ date: '2026-11-04', percent: null, readings: null, avgDelayMin: null });
	});

	it('draws no low or high from fewer than two measured days', () => {
		const result = selectDailyOnTime([counted('2026-11-04', 70, 100), day('2026-11-05', {})]);
		expect(result.low).toBeNull();
		expect(result.high).toBeNull();
	});

	it('keeps each share inside its definition across generated seeds', () => {
		let state = 4_101_115;
		const next = (max: number) => {
			state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
			return state % max;
		};
		for (let trial = 0; trial < 300; trial += 1) {
			const readings = 1 + next(20_000);
			const onTime = next(readings + 1);
			const [row] = selectDailyOnTime([counted('2026-11-04', onTime, readings)]).rows;
			// The shown tenths are exact, rounded half up, from the integer counts.
			expect(Math.round(row.percent! * 10)).toBe(
				Math.floor((2000 * onTime + readings) / (2 * readings)),
			);
			expect(row.percent! >= 0 && row.percent! <= 100).toBe(true);
			expect(row.readings).toBe(readings);
		}
	});
});
