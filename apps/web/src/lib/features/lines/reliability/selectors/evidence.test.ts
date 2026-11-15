import { describe, expect, it } from 'vitest';
import type { CancellationPeriod, SkippedStopPeriod, WeakStop } from '#lib/v1/index.ts';
import type { PeriodComparisonRow } from '../clusters';
import {
	countShare,
	cutScope,
	selectStopDelays,
	selectTimeOfDay,
	selectTripFacts,
} from './evidence';

/** A small deterministic generator, so the sweeps are reproducible from their seed. */
function seeded(seed: number) {
	let state = seed >>> 0;
	return (max: number) => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state % (max + 1);
	};
}

const isPlainNumber = (value: number) => Number.isFinite(value) && !Object.is(value, -0);

describe('countShare', () => {
	it('rounds exact halves up, in whole percent or tenths', () => {
		expect(countShare(1, 200, 0)).toBe(1); // 0.5 %
		expect(countShare(2, 3, 0)).toBe(67); // 66.67 %
		expect(countShare(1, 8, 1)).toBe(12.5); // exactly 12.5 %
		expect(countShare(1, 16, 1)).toBe(6.3); // 6.25 %
		expect(countShare(36, 1019, 1)).toBe(3.5); // 3.533 %
		expect(countShare(65_214, 4_984_621, 1)).toBe(1.3); // 1.308 %
	});

	it('gives a plain zero and a plain hundred at the ends', () => {
		expect(Object.is(countShare(0, 5, 1), 0)).toBe(true);
		expect(countShare(5, 5, 0)).toBe(100);
	});

	it('withholds counts that break their definition', () => {
		for (const [part, whole] of [
			[5, 4],
			[-1, 4],
			[1.5, 4],
			[0, 0],
			[1, Number.NaN],
			[Number.POSITIVE_INFINITY, 4],
		])
			expect(countShare(part, whole, 1)).toBeNull();
	});

	it('stays within half a unit of the exact share for 400 seeded pairs', () => {
		const next = seeded(43);
		for (let i = 0; i < 400; i += 1) {
			const whole = next(2_000_000) + 1;
			const part = next(whole);
			for (const decimals of [0, 1] as const) {
				const shown = countShare(part, whole, decimals)!;
				const unit = decimals === 0 ? 1 : 0.1;
				const exact = (100 * part) / whole;
				expect(isPlainNumber(shown)).toBe(true);
				expect(shown).toBeGreaterThanOrEqual(0);
				expect(shown).toBeLessThanOrEqual(100);
				// Whole units of its precision: whole percent or whole tenths.
				const scaled = shown * 10 ** decimals;
				expect(Math.abs(scaled - Math.round(scaled))).toBeLessThan(1e-9);
				// Half up: the exact share sits in [shown − ½ unit, shown + ½ unit).
				expect(exact).toBeGreaterThanOrEqual(shown - unit / 2 - 1e-9);
				expect(exact).toBeLessThan(shown + unit / 2 + 1e-9);
			}
		}
	});
});

describe('cutScope', () => {
	const base = { closedThrough: '2026-11-10', hasRows: true, windowed: true };

	it('names the cut’s own days for a closed day, week or month', () => {
		expect(cutScope({ ...base, mode: 'day', date: '2026-11-10' })).toEqual({
			kind: 'window',
			from: '2026-11-10',
			to: '2026-11-10',
		});
		expect(cutScope({ ...base, mode: 'week', date: '2026-11-04' })).toEqual({
			kind: 'window',
			from: '2026-11-04',
			to: '2026-11-10',
		});
	});

	it('never lends the latest day’s cut to a chosen range', () => {
		expect(cutScope({ ...base, mode: 'range', date: '2026-11-10' })).toEqual({
			kind: 'none',
			range: true,
		});
	});

	it('calls an undated, unwindowed cut all available history', () => {
		expect(cutScope({ ...base, mode: 'day', windowed: false, date: null })).toEqual({
			kind: 'history',
		});
	});

	it('withholds a cut whose days cannot be named', () => {
		expect(cutScope({ ...base, mode: 'week', date: null })).toEqual({ kind: 'none' });
		expect(cutScope({ ...base, mode: 'week', date: '2026-11-12' })).toEqual({ kind: 'none' });
		expect(cutScope({ ...base, mode: 'week', date: '2026-11-04', closedThrough: null })).toEqual({
			kind: 'none',
		});
		expect(cutScope({ ...base, mode: 'day', date: '2026-11-10', hasRows: false })).toEqual({
			kind: 'none',
		});
	});
});

const cut = (
	grain: string,
	onTime: number | null,
	readings: number | null,
	otp: number | null = null,
) =>
	({
		grain,
		otpPct: otp,
		avgDelayMin: null,
		severePct: null,
		observationCount: readings,
		onTime,
		priorOtpPct: null,
		priorObservationCount: null,
		priorOnTime: null,
	}) satisfies PeriodComparisonRow;

describe('selectTimeOfDay', () => {
	it('orders the periods of the day and defines each share from its counts', () => {
		const result = selectTimeOfDay(
			[cut('night', 437, 480), cut('am_peak', 73_419, 80_927), cut('pm_peak', 61_001, 70_000)],
			[cut('weekend', 9, 10), cut('weekday', 1, 3)],
		);
		expect(result.periods).toEqual([
			{ key: 'am_peak', percent: 91, readings: 80_927 },
			{ key: 'pm_peak', percent: 87, readings: 70_000 },
			{ key: 'night', percent: 91, readings: 480 },
		]);
		expect(result.dayTypes).toEqual([
			{ key: 'weekday', percent: 33, readings: 3 },
			{ key: 'weekend', percent: 90, readings: 10 },
		]);
		expect(result.spread).toEqual({ low: 87, high: 91, lowest: ['pm_peak'] });
	});

	it('names every period tied at the lowest shown value', () => {
		const result = selectTimeOfDay([cut('midday', 88, 100), cut('evening', 879, 1000)], []);
		expect(result.spread).toEqual({ low: 88, high: 88, lowest: ['midday', 'evening'] });
	});

	it('shows no share for zero readings or counts that break their definition', () => {
		const result = selectTimeOfDay(
			[cut('am_peak', 0, 0), cut('midday', 12, 10), cut('evening', null, null, 140)],
			[cut('weekday', null, 50, 82)],
		);
		expect(result.periods.map((row) => row.percent)).toEqual([null, null, null]);
		expect(result.periods.every((row) => row.readings === null)).toBe(true);
		// A published whole share with its reading count but no on-time count is kept.
		expect(result.dayTypes).toEqual([{ key: 'weekday', percent: 82, readings: 50 }]);
		expect(result.spread).toBeNull();
	});

	it('keeps every share in [0, 100] and the lowest at the minimum for 300 seeded cuts', () => {
		const next = seeded(7);
		for (let i = 0; i < 300; i += 1) {
			const rows = ['am_peak', 'midday', 'pm_peak', 'evening', 'night'].map((grain) => {
				const readings = next(5_000);
				return cut(grain, next(readings), readings);
			});
			const { periods, spread } = selectTimeOfDay(rows, []);
			const shown = periods.flatMap((row) => (row.percent == null ? [] : [row.percent]));
			for (const row of periods) {
				if (row.percent == null) continue;
				expect(isPlainNumber(row.percent) && row.percent >= 0 && row.percent <= 100).toBe(true);
				expect(row.readings).toBeGreaterThan(0);
			}
			if (shown.length < 2) expect(spread).toBeNull();
			else {
				expect(spread!.low).toBe(Math.min(...shown));
				expect(spread!.high).toBe(Math.max(...shown));
				for (const key of spread!.lowest)
					expect(periods.find((row) => row.key === key)!.percent).toBe(spread!.low);
			}
		}
	});
});

const stop = (
	id: string,
	severe: number | null,
	readings: number | null,
	name: string | null = id,
) =>
	({
		id,
		name,
		severe_pct: severe,
		observation_count: readings,
		wilson_lo: 5,
		wilson_hi: 15,
	}) satisfies WeakStop;

describe('selectStopDelays', () => {
	it('lists the published stops by their shown share, most late first, with no interval', () => {
		const rows = selectStopDelays([
			stop('a', 63.9, 900),
			stop('b', 61.2, 2_000),
			stop('c', 61.6, 1_500),
			stop('d', 61.2, 3_000),
		]);
		expect(rows.map((row) => row.id)).toEqual(['a', 'c', 'd', 'b']);
		expect(rows[0]).toEqual({ id: 'a', name: 'a', percent: 63.9, readings: 900 });
		expect(rows.every((row) => !('lo' in row) && !('hi' in row))).toBe(true);
	});

	it('leaves out a stop without a valid share and keeps an unknown reading count unknown', () => {
		const rows = selectStopDelays([
			stop('a', null, 10),
			stop('b', 101, 10),
			stop('c', Number.NaN, 10),
			stop('d', 20, -4),
			stop('e', -0, 12.5),
		]);
		expect(rows).toEqual([
			{ id: 'd', name: 'd', percent: 20, readings: null },
			{ id: 'e', name: 'e', percent: 0, readings: null },
		]);
		expect(Object.is(rows[1].percent, 0)).toBe(true);
	});

	it('orders 200 seeded lists by the shown value', () => {
		const next = seeded(11);
		for (let i = 0; i < 200; i += 1) {
			const stops = Array.from({ length: 15 }, (_, j) =>
				stop(`s${j}`, next(1000) / 10, next(5000)),
			);
			const shown = selectStopDelays(stops).map((row) => row.percent);
			expect(shown).toEqual([...shown].sort((a, b) => b - a));
		}
	});
});

const day = (date: string, cancelled: number, seen: number) =>
	({
		grain: 'day',
		date,
		canceled_trip_days: cancelled,
		total_trip_days: seen,
	}) satisfies CancellationPeriod;
const skip = (date: string, skipped: number, updates: number) =>
	({
		date,
		skipped_stop_count: skipped,
		stop_time_update_count: updates,
	}) satisfies SkippedStopPeriod;

describe('selectTripFacts', () => {
	const week = { from: '2026-11-04', to: '2026-11-10', days: 7 };

	it('sums the period’s own days and defines each share from the sums', () => {
		const facts = selectTripFacts(
			[
				day('2026-11-03', 99, 100),
				day('2026-11-04', 20, 500),
				day('2026-11-10', 16, 519),
				day('2026-11-11', 50, 60),
			],
			[skip('2026-11-04', 65_000, 4_000_000), skip('2026-11-09', 214, 984_621)],
			week,
		);
		expect(facts.cancelled).toEqual({ count: 36, total: 1_019, percent: 3.5, days: 2 });
		expect(facts.skipped).toEqual({ count: 65_214, total: 4_984_621, percent: 1.3, days: 2 });
	});

	it('withholds a period whose counts break their definition', () => {
		const facts = selectTripFacts(
			[day('2026-11-04', 6, 5), day('2026-11-05', 1, 10)],
			[skip('2026-11-04', -1, 10)],
			week,
		);
		expect(facts.cancelled).toBeNull();
		expect(facts.skipped).toBeNull();
	});

	it('publishes nothing without a period or without trips seen', () => {
		expect(selectTripFacts([day('2026-11-04', 0, 0)], [], week).cancelled).toBeNull();
		expect(selectTripFacts([day('2026-11-04', 1, 10)], [], null).cancelled).toBeNull();
	});

	it('keeps counts and shares consistent for 300 seeded weeks', () => {
		const next = seeded(5);
		for (let i = 0; i < 300; i += 1) {
			const rows = ['04', '05', '06', '07', '08', '09', '10'].map((d) => {
				const seen = next(600);
				return day(`2026-11-${d}`, next(seen), seen);
			});
			const facts = selectTripFacts(rows, [], week);
			const total = rows.reduce((sum, row) => sum + row.total_trip_days, 0);
			if (total === 0) {
				expect(facts.cancelled).toBeNull();
				continue;
			}
			const { count, total: shownTotal, percent } = facts.cancelled!;
			expect(count).toBeLessThanOrEqual(shownTotal);
			expect(count).toBeGreaterThanOrEqual(0);
			expect(isPlainNumber(percent) && percent >= 0 && percent <= 100).toBe(true);
			expect(Math.abs(percent - (100 * count) / shownTotal)).toBeLessThanOrEqual(0.05 + 1e-9);
		}
	});
});
