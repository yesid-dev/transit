import type { ReliabilityPeriod } from '#lib/v1/index.ts';
import { roundHalfAwayFromZero } from '#lib/utils/index.ts';

export interface DailyOnTimeRow {
	readonly date: string;
	/** Percent of the day's readings on time, to one decimal, or null when not published. */
	readonly percent: number | null;
	readonly readings: number | null;
	readonly avgDelayMin: number | null;
}

export interface DailyExtreme {
	readonly date: string;
	readonly percent: number;
}

export interface DailyOnTime {
	readonly rows: readonly DailyOnTimeRow[];
	/** Lowest and highest measured days; null with fewer than two measured days. */
	readonly low: DailyExtreme | null;
	readonly high: DailyExtreme | null;
}

const isCount = (value: number | null | undefined): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0;

const tenth = (value: number | null | undefined): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? roundHalfAwayFromZero(value, 1) + 0 : null;

function dayRow(period: ReliabilityPeriod & { readonly date: string }): DailyOnTimeRow {
	const readings = period.observation_count;
	const onTime = period.on_time;
	// A published reading count must be whole and at least one: no share exists without readings.
	const readingsValid = readings == null || (isCount(readings) && readings > 0);
	let percent: number | null = null;
	if (readingsValid && onTime != null) {
		// Both counts published: they define the share, in whole tenths rounded half up.
		if (readings != null && isCount(onTime) && onTime <= readings)
			percent = Math.floor((2000 * onTime + readings) / (2 * readings)) / 10;
	} else if (readingsValid) {
		const published = tenth(period.otp_pct);
		percent = published != null && published >= 0 && published <= 100 ? published : null;
	}
	return {
		date: period.date,
		percent,
		readings: percent != null && readings != null ? readings : null,
		// An average of zero readings does not exist; it is never shown as 0.
		avgDelayMin: readings === 0 ? null : tenth(period.avg_delay_min),
	};
}

const DAY_MS = 86_400_000;

/** Every calendar day of a window, inclusive; empty for a malformed or reversed window. */
function windowDays(window: { readonly from: string; readonly to: string }): string[] {
	const start = Date.parse(`${window.from}T00:00:00Z`);
	const end = Date.parse(`${window.to}T00:00:00Z`);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
	return Array.from({ length: (end - start) / DAY_MS + 1 }, (_, index) =>
		new Date(start + index * DAY_MS).toISOString().slice(0, 10),
	);
}

/**
 * One measure per complete day: the share of readings on time. With a `window`, every day of it
 * gets a row and a day the record does not publish is a gap; days outside it are left out. A day
 * whose counts break their definition is a gap too, never a zero.
 */
export function selectDailyOnTime(
	trend: readonly ReliabilityPeriod[],
	window?: { readonly from: string; readonly to: string } | null,
): DailyOnTime {
	const published = new Map(
		trend
			.filter((p): p is ReliabilityPeriod & { readonly date: string } => p.date != null)
			.map((p) => [p.date, dayRow(p)] as const),
	);
	const gap = (date: string): DailyOnTimeRow => ({
		date,
		percent: null,
		readings: null,
		avgDelayMin: null,
	});
	const rows = window
		? windowDays(window).map((date) => published.get(date) ?? gap(date))
		: [...published.values()].sort((a, b) => a.date.localeCompare(b.date));
	const measured = rows.filter(
		(row): row is DailyOnTimeRow & { readonly percent: number } => row.percent != null,
	);
	if (measured.length < 2) return { rows, low: null, high: null };
	const pick = (better: (a: number, b: number) => boolean) =>
		measured.reduce((best, row) => (better(row.percent, best.percent) ? row : best));
	const low = pick((a, b) => a < b);
	const high = pick((a, b) => a > b);
	return {
		rows,
		low: { date: low.date, percent: low.percent },
		high: { date: high.date, percent: high.percent },
	};
}
