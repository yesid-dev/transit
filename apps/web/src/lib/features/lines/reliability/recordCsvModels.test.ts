import { describe, expect, it } from 'vitest';
import { chartRows } from './chartCsv';
import { dailyRows, gapRows, stopRows, spanRows, tripRows, rounded } from './recordCsvModels';
import { selectDailyOnTime } from './selectors/punctualityTrend';
import { selectStopDelays, selectTimeOfDay, selectTripFacts } from './selectors/evidence';
import { timeRows } from './recordCsvModels';
import { selectPunctualityCrosstab } from './selectors/punctualityCrosstab';

describe('line export models', () => {
	it('preserves gaps, count-based daily tenths, true zero and signed fractional delay', () => {
		const daily = selectDailyOnTime(
			[
				{
					grain: 'day',
					date: '2026-10-02',
					observation_count: 3,
					on_time: 2,
					avg_delay_min: -1.25,
				},
				{ grain: 'day', date: '2026-10-03', observation_count: 30, on_time: 0, avg_delay_min: 0 },
			],
			{ from: '2026-10-01', to: '2026-10-03' },
		);
		expect(dailyRows(daily).map((row) => [row.state, row.readings, ...row.cells])).toEqual([
			['gap', null, '2026-10-01', null, null],
			['published', 3, '2026-10-02', 66.7, -1.3],
			['published', 30, '2026-10-03', 0, 0],
		]);
		expect(rounded(-0.04)).toBe(0);
		expect(rounded(Infinity)).toBeNull();
	});
	it('exports exactly the selected stop list and no complementary confidence interval', () => {
		const stops = selectStopDelays([
			{ id: 'a/b', name: null, severe_pct: 0, observation_count: 30 },
			{ id: 'c', name: 'Station', severe_pct: 10.25, observation_count: 1.5 },
			{ id: 'bad', severe_pct: 101 },
		]);
		expect(stopRows(stops.slice(0, 1), (r) => r.name ?? 'Stop ' + r.id)).toEqual([
			{
				measure: 'readings_more_than_5_minutes_late',
				unit: '%',
				readings: null,
				cells: [1, 'c', 'Station', 'published', 10.3],
			},
		]);
		expect(stopRows(stops, (r) => r.name ?? 'Stop ' + r.id)[1].cells).toEqual([
			2,
			'a/b',
			'Stop a/b',
			'fallback',
			0,
		]);
	});
	it('does not turn a nonpositive gap into a duration, while keeping negative span delays', () => {
		expect(
			gapRows([{ shift: 'night', scheduled_min: 0, observed_min: 12.25 }], () => 'Night')[0].cells,
		).toEqual(['night', 'Night', undefined, undefined, null, 12.3]);
		expect(
			spanRows({
				date: '2026-10-09',
				first_trip_utc: '2026-10-09T01:00:00Z',
				last_trip_utc: '2026-10-09T23:00:00Z',
				service_span_min: 1320,
				first_trip_delay_min: -0.55,
				last_trip_delay_min: 0,
				trip_count: 12,
			})[0].cells,
		).toEqual(['2026-10-09', '2026-10-09T01:00:00Z', '2026-10-09T23:00:00Z', 1320, -0.6, 0, 12]);
	});
	it('retains trip fact basis and observed days, missing/live-only states, and gated completeness', () => {
		const period = { from: '2026-10-01', to: '2026-10-03', days: 3 };
		const facts = selectTripFacts(
			[{ date: '2026-10-02', canceled_trip_days: 0, total_trip_days: 30 }],
			[],
			period,
		);
		const rows = tripRows(facts, null, null);
		expect(rows.map((r) => [r.measure, r.state, ...r.cells])).toEqual([
			['cancelled', 'published', 0, 0, 30, 'observed_trip_days', 1, null],
			['missing_trips', 'not_published', null, null, null, null, null, null],
			['silent_trips', 'live_only', null, null, null, null, null, null],
			['skipped', 'not_published', null, null, null, 'stop_time_updates', null, null],
		]);
		expect(tripRows(facts, { delivered: 27, scheduled: 30, silent: 2 }, 90)[4].cells).toEqual([
			90,
			27,
			30,
			'scheduled_trip_days',
			null,
			2,
		]);
		for (const [part, whole] of [
			[0, 0],
			[-1, 30],
			[1.5, 30],
			[31, 30],
			[NaN, 30],
			[1, Infinity],
		]) {
			const invalid = selectTripFacts(
				[{ date: '2026-10-02', canceled_trip_days: part, total_trip_days: whole }],
				[],
				period,
			);
			expect(tripRows(invalid, null, null)[0].cells.slice(0, 3)).toEqual([null, null, null]);
		}
	});
	it('takes counts from the existing table selector and withholds a zero-denominator cut', () => {
		const cut = (grain: string, onTime: number, observationCount: number) => ({
			grain,
			onTime,
			observationCount,
			otpPct: null,
			avgDelayMin: null,
			severePct: null,
			priorOtpPct: null,
			priorObservationCount: null,
			priorOnTime: null,
		});
		const rows = timeRows(
			selectTimeOfDay([cut('am_peak', 2, 3), cut('midday', 0, 0)], []),
			(key) => key,
		);
		expect(rows.map((r) => [r.readings, r.state, ...r.cells])).toEqual([
			[3, 'published', 'period', 'am_peak', 'am_peak', 67],
			[null, 'not_published', 'period', 'midday', 'midday', null],
		]);
	});
	it('exports normalized histogram bins with explicit open bounds in displayed minutes', () => {
		const rows = chartRows(
			{
				kind: 'histogram',
				title: 'Delays',
				locale: 'en',
				domain: [-600, 600],
				countDomain: [0, 30],
				unit: ' s',
				medianRef: -30,
				p90Ref: 330,
				bins: [
					{ lo: null, hi: -60, count: 2 },
					{ lo: -60, hi: 300, count: 28 },
					{ lo: 300, hi: null, count: 0 },
				],
			},
			'delay_histogram',
		);
		expect(rows.map((r) => r.cells)).toEqual([
			['0', null, null, 2, null, -0.5, 5.5, null, -1, 'unbounded', 'bounded'],
			['1', null, null, 28, null, -0.5, 5.5, -1, 5, 'bounded', 'bounded'],
			['2', null, null, 0, null, -0.5, 5.5, 5, null, 'bounded', 'unbounded'],
		]);
		expect(rows[0].unit).toBe('readings; min');
	});
	it('keeps the dot-strip reference as mean, null crosstab points, row-relative score and rounded mix without invented readings', () => {
		const strip = chartRows(
			{
				kind: 'dot-strip',
				title: 'Severe',
				locale: 'en',
				domain: [0, 100],
				unit: '%',
				scale: 'severity',
				medianRef: 4.25,
				points: [
					{ key: 'am', group: 'Morning', value: 0 },
					{ key: 'pm', group: 'Afternoon', value: null },
				],
			},
			'severe',
		);
		expect(strip[0].cells).toEqual([
			'am',
			'Morning',
			null,
			0,
			4.25,
			null,
			null,
			null,
			null,
			null,
			null,
		]);
		const cross = selectPunctualityCrosstab(
			[
				{ shift: 'am_peak', day_type: 'weekday', observation_count: 29, otp_pct: 100 },
				{ shift: 'pm_peak', day_type: 'weekend', observation_count: 30, otp_pct: 0 },
			],
			'en',
			{
				title: 'Cuts',
				xLabel: 'Time',
				yLabel: 'OTP',
				shiftLabel: (s) => s,
				weekdayLabel: 'Weekdays',
				weekendLabel: 'Weekends',
			},
		);
		expect(
			chartRows(cross.spec, 'on_time')
				.filter((r) => r.cells[3] != null)
				.map((r) => r.cells.slice(1, 4)),
		).toEqual([['pm_peak', 'Weekends', 0]]);
		const mix = chartRows(
			{
				kind: 'stacked-share',
				title: 'Mix',
				locale: 'en',
				scale: 'occupancy',
				segments: [{ key: 'full', label: 'Full', share: 33.3333 }],
			},
			'mix',
		);
		expect(mix[0]).toMatchObject({ readings: undefined, unit: '%' });
		expect(mix[0].cells).toEqual([
			'full',
			'Full',
			null,
			33,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
		]);
		expect(
			chartRows(
				{
					kind: 'heatmap',
					mode: 'absolute',
					title: 'Relative',
					locale: 'en',
					rowLabels: ['Mon'],
					colLabels: ['00:00', '01:00'],
					cells: [[{ value: 0 }, { value: null }]],
				},
				'relative',
			).map((r) => [r.unit, r.cells[3]]),
		).toEqual([
			['row_relative_score', 0],
			['row_relative_score', null],
		]);
	});
});
