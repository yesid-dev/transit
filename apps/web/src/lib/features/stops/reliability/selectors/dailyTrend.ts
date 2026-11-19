import type { DateWindow } from '#lib/filters/index.ts';
import type { StopDailyPoint } from '#lib/v1/index.ts';
import { lateShareTenths, publishedShareAgrees } from '../../lateShare';

/** Which days the chart shows: the visitor's dates, the record's week, or the file's last week. */
export type DayByDayBasis = 'chosen' | 'record' | 'latest';

export interface DayByDayRow {
	readonly date: string;
	/** Share of the day's readings more than 5 minutes late, one decimal; null for a gap. */
	readonly percent: number | null;
	readonly readings: number | null;
	readonly lateReadings: number | null;
	/** Why a day has no share: absent or unreadable in the file, or a day without readings. */
	readonly gap: 'not-published' | 'no-readings' | null;
}

export interface DayExtreme {
	readonly date: string;
	readonly percent: number;
}

export interface DayByDay {
	readonly basis: DayByDayBasis | null;
	readonly from: string | null;
	readonly to: string | null;
	/** Every calendar day of the window, oldest first. */
	readonly rows: readonly DayByDayRow[];
	readonly measuredDays: number;
	readonly gapDays: number;
	/** Fewest and most readings on a measured day. */
	readonly fewestReadings: number | null;
	readonly mostReadings: number | null;
	/** Lowest and highest measured days, the earliest on a tie; null with fewer than two. */
	readonly low: DayExtreme | null;
	readonly high: DayExtreme | null;
}

const DAY_MS = 86_400_000;
const LATEST_DAYS = 7;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;

function dayTime(key: string): number {
	return ISO_DAY.test(key) ? Date.parse(`${key}T00:00:00Z`) : Number.NaN;
}

const dayKey = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Every calendar day of a window, inclusive; empty for a malformed or reversed window. */
function windowDays(window: DateWindow): string[] {
	const start = dayTime(window.from);
	const end = dayTime(window.to);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
	return Array.from({ length: (end - start) / DAY_MS + 1 }, (_, index) =>
		dayKey(start + index * DAY_MS),
	);
}

function dayRow(point: StopDailyPoint): DayByDayRow {
	const gap = (reason: 'not-published' | 'no-readings'): DayByDayRow => ({
		date: point.date,
		percent: null,
		readings: null,
		lateReadings: null,
		gap: reason,
	});
	if (point.observation_count === 0) return gap('no-readings');
	const tenths = lateShareTenths(point.severe_count, point.observation_count);
	if (tenths == null) return gap('not-published');
	if (point.severe_pct != null && !publishedShareAgrees(point.severe_pct, tenths))
		return gap('not-published');
	return {
		date: point.date,
		percent: tenths / 10,
		readings: point.observation_count,
		lateReadings: point.severe_count,
		gap: null,
	};
}

function latestWeek(daily: readonly StopDailyPoint[]): DateWindow | null {
	const last = daily
		.map((point) => dayTime(point.date))
		.filter(Number.isFinite)
		.reduce((latest, time) => Math.max(latest, time), Number.NEGATIVE_INFINITY);
	if (!Number.isFinite(last)) return null;
	return { from: dayKey(last - (LATEST_DAYS - 1) * DAY_MS), to: dayKey(last) };
}

/**
 * The stop's Day by day: one share a day, for the dates the visitor chose, else the record's
 * week, else the file's latest seven calendar days. A day the file does not publish, whose
 * counts break their definition, or that has no readings is a gap, never a zero.
 */
export function selectDayByDay(
	daily: readonly StopDailyPoint[] | null | undefined,
	windows: { readonly chosen: DateWindow | null; readonly record: DateWindow | null },
): DayByDay {
	const points = daily ?? [];
	const latest = latestWeek(points);
	const [basis, window]: [DayByDayBasis | null, DateWindow | null] = windows.chosen
		? ['chosen', windows.chosen]
		: windows.record
			? ['record', windows.record]
			: latest
				? ['latest', latest]
				: [null, null];

	const published = new Map<string, DayByDayRow>();
	for (const point of points)
		if (!published.has(point.date)) published.set(point.date, dayRow(point));
	const rows = (window ? windowDays(window) : []).map(
		(date): DayByDayRow =>
			published.get(date) ?? {
				date,
				percent: null,
				readings: null,
				lateReadings: null,
				gap: 'not-published',
			},
	);

	const measured = rows.filter(
		(row): row is DayByDayRow & { percent: number; readings: number } => row.percent != null,
	);
	const pick = (better: (a: number, b: number) => boolean) =>
		measured.reduce((best, row) => (better(row.percent, best.percent) ? row : best));
	const extreme = (row: DayByDayRow & { percent: number }): DayExtreme => ({
		date: row.date,
		percent: row.percent,
	});
	const readings = measured.map((row) => row.readings);
	return {
		basis,
		from: window?.from ?? null,
		to: window?.to ?? null,
		rows,
		measuredDays: measured.length,
		gapDays: rows.length - measured.length,
		fewestReadings: readings.length ? Math.min(...readings) : null,
		mostReadings: readings.length ? Math.max(...readings) : null,
		low: measured.length >= 2 ? extreme(pick((a, b) => a < b)) : null,
		high: measured.length >= 2 ? extreme(pick((a, b) => a > b)) : null,
	};
}
