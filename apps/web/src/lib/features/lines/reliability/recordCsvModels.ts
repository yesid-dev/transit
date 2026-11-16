import { roundHalfAwayFromZero } from '#lib/utils/rounding.ts';
import type { HeadwayPeriod, ServiceSpanPeriod } from '#lib/v1/index.ts';
import type { ServiceDeliveredVM, PunctualityVM } from './clusters';
import type { DailyOnTime } from './selectors/punctualityTrend';
import type { LineRecord } from './selectors/lineRecord';
import type { StopDelayRow, TimeOfDay, TripFacts } from './selectors/evidence';
import { csvCount, csvNumber, csvPercent, type CsvRow } from './recordCsv';

export const rounded = (value: number | null | undefined, digits = 1): number | null => {
	const n = csvNumber(value);
	return n == null ? null : roundHalfAwayFromZero(n, digits);
};
const state = (value: number | null) => (value == null ? 'not_published' : 'published');

export function answerRows(record: LineRecord): CsvRow[] {
	const a = record.answer;
	return a.kind !== 'figure'
		? []
		: [
				{
					measure: 'share_of_readings_on_time',
					unit: '%',
					readings: a.readings,
					readingsBasis: 'on_time_share',
					cells: [
						csvPercent(a.percent),
						csvPercent(a.interval?.lo),
						csvPercent(a.interval?.hi),
						a.classification,
					],
				},
			];
}

export function dailyRows(daily: DailyOnTime): CsvRow[] {
	return daily.rows.map((row) => ({
		measure: 'daily_on_time_share_and_average_delay',
		unit: '%; min',
		readings: row.readings,
		readingsBasis: 'on_time_share',
		state: row.percent == null && row.avgDelayMin == null ? 'gap' : 'published',
		cells: [row.date, csvPercent(row.percent), rounded(row.avgDelayMin)],
	}));
}

export function delayRows(
	headline: PunctualityVM['headline'],
	averageReadings: number | null = null,
	percentileReadings: number | null = null,
): CsvRow[] {
	const measured = headline.observationCount !== 0;
	return [
		['average_delay', headline.avgDelayMin],
		['p50_delay', headline.p50Min],
		['p90_delay', headline.p90Min],
	].map(([key, value]) => {
		const v = measured ? rounded(value as number | null) : null;
		return {
			measure: String(key),
			unit: 'min',
			readings: csvCount(key === 'average_delay' ? averageReadings : percentileReadings),
			readingsBasis:
				key === 'average_delay' && csvCount(averageReadings) != null
					? 'in_clamp_delay_predictions'
					: key !== 'average_delay' && csvCount(percentileReadings) != null
						? 'published_delay_percentile_observations'
						: '',
			state: state(v),
			cells: [v, csvCount(headline.observationCount)],
		};
	});
}

export function timeRows(model: TimeOfDay, label: (key: string) => string): CsvRow[] {
	return [
		...model.periods.map((r) => ({ ...r, group: 'period' })),
		...model.dayTypes.map((r) => ({ ...r, group: 'day_type' })),
	].map((row) => ({
		measure: 'share_of_readings_on_time',
		unit: '%',
		readings: row.readings,
		state: state(row.percent),
		cells: [row.group, row.key, label(row.key), csvPercent(row.percent)],
	}));
}

export function stopRows(
	rows: readonly StopDelayRow[],
	name: (row: StopDelayRow) => string,
): CsvRow[] {
	return rows.map((row, index) => ({
		measure: 'readings_more_than_5_minutes_late',
		unit: '%',
		readings: row.readings,
		cells: [
			index + 1,
			row.id,
			name(row),
			row.name == null ? 'fallback' : 'published',
			csvPercent(row.percent),
		],
	}));
}

export function gapRows(
	rows: readonly HeadwayPeriod[],
	label: (row: HeadwayPeriod) => string,
): CsvRow[] {
	const positive = (v: number | null | undefined) =>
		v != null && Number.isFinite(v) && v > 0 ? Math.round(v * 10) / 10 + 0 : null;
	return rows.map((row) => ({
		measure: 'median_gap_between_trips',
		unit: 'min',
		readings: csvCount(row.observation_count),
		state:
			positive(row.scheduled_min) == null && positive(row.observed_min) == null
				? 'not_published'
				: 'published',
		cells: [
			row.shift,
			label(row),
			row.direction_id,
			row.day_type,
			positive(row.scheduled_min),
			positive(row.observed_min),
		],
	}));
}

export function spanRows(span: ServiceSpanPeriod): CsvRow[] {
	return [
		{
			measure: 'service_span',
			unit: 'UTC; min; trips',
			cells: [
				span.date,
				span.first_trip_utc,
				span.last_trip_utc,
				span.service_span_min != null && span.service_span_min >= 0
					? rounded(span.service_span_min)
					: null,
				rounded(span.first_trip_delay_min),
				rounded(span.last_trip_delay_min),
				csvCount(span.trip_count),
			],
		},
	];
}

export function tripRows(
	facts: TripFacts,
	completeness: ServiceDeliveredVM['scheduledService'],
	percent: number | null,
): CsvRow[] {
	const rows: CsvRow[] = (['cancelled', 'skipped'] as const).map((key) => {
		const fact = facts[key];
		return {
			measure: key,
			unit: '%',
			state: fact ? 'published' : 'not_published',
			cells: [
				csvPercent(fact?.percent),
				csvCount(fact?.count),
				csvCount(fact?.total),
				key === 'cancelled' ? 'observed_trip_days' : 'stop_time_updates',
				csvCount(fact?.days),
				null,
			],
		};
	});
	rows.splice(
		1,
		0,
		{
			measure: 'missing_trips',
			unit: 'trips',
			state: 'not_published',
			cells: [null, null, null, null, null, null],
		},
		{
			measure: 'silent_trips',
			unit: 'trips',
			state: 'live_only',
			cells: [null, null, null, null, null, null],
		},
	);
	if (completeness)
		rows.push({
			measure: 'service_completeness',
			unit: '%',
			state: state(csvPercent(percent)),
			cells: [
				rounded(csvPercent(percent)),
				csvCount(completeness.delivered),
				csvCount(completeness.scheduled),
				'scheduled_trip_days',
				null,
				csvCount(completeness.silent),
			],
		});
	return rows;
}
