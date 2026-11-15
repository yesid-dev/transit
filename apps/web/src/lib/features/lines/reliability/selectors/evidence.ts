import type { CancellationPeriod, SkippedStopPeriod, WeakStop } from '#lib/v1/index.ts';
import { DAY_TYPE_GRAIN_ORDER, SHIFT_GRAIN_ORDER } from '#lib/features/reliability/shiftGrains.ts';
import type { CrowdingVM, PeriodComparisonRow } from '../clusters';
import type { RecordMode, RecordPeriod } from './lineRecord';

const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * `part` of `whole` in percent, rounded half up to whole percent (0) or tenths (1), computed from
 * the integer counts so no float drift moves a half. Null when the counts break their definition:
 * not whole, negative, a part above its whole, or nothing to divide by.
 */
export function countShare(part: number, whole: number, decimals: 0 | 1): number | null {
	if (!isCount(part) || !isCount(whole) || whole === 0 || part > whole) return null;
	const scale = 100 * 10 ** decimals;
	return Math.floor((2 * scale * part + whole) / (2 * whole)) / 10 ** decimals + 0;
}

/** Which days one published cut covers, so it can say so beside its numbers. */
export type CutScope =
	| { readonly kind: 'window'; readonly from: string; readonly to: string }
	| { readonly kind: 'history' }
	| { readonly kind: 'none'; readonly range?: true };

export interface CutScopeInput {
	readonly mode: RecordMode;
	/** The cut's own first day, as published beside it (`*_by_grain[].date`). */
	readonly date: string | null | undefined;
	/**
	 * The same family's own day row (`*_by_grain` grain `day`), when it publishes one. Families
	 * close on their own anchors: one family's day is never another's.
	 */
	readonly anchor: string | null | undefined;
	/** True when the cut belongs to the chosen grain, false for the all-history fallback. */
	readonly windowed: boolean;
	readonly hasRows: boolean;
}

const GRAIN_DAYS = { day: 1, week: 7, month: 30 } as const;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/u;

/** `date` plus `days`, as a date key; null for a malformed key. */
function addDays(date: string, days: number): string | null {
	if (!DATE_KEY.test(date)) return null;
	const at = new Date(`${date}T00:00:00Z`);
	if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== date) return null;
	at.setUTCDate(at.getUTCDate() + days);
	return at.toISOString().slice(0, 10);
}

/**
 * A grain's cut covers its published first day and the grain's fixed length (1, 7 or 30 days).
 * When its family also publishes a day row, that anchor must be the cut's last day; a cut whose
 * days disagree is withheld rather than named. A chosen range has no cut of its own: the latest
 * day's cut is never shown as if it described the range.
 */
export function cutScope({ mode, date, anchor, windowed, hasRows }: CutScopeInput): CutScope {
	if (mode === 'range') return { kind: 'none', range: true };
	if (!hasRows) return { kind: 'none' };
	if (!windowed) return { kind: 'history' };
	const to = date ? addDays(date, GRAIN_DAYS[mode] - 1) : null;
	if (!date || !to || (anchor != null && anchor !== to)) return { kind: 'none' };
	return { kind: 'window', from: date, to };
}

export interface ShareRow {
	readonly key: string;
	/** Whole percent of readings on time, or null when not published. */
	readonly percent: number | null;
	/** Readings behind the share, only alongside a share. */
	readonly readings: number | null;
}

export interface TimeOfDay {
	readonly periods: readonly ShareRow[];
	readonly dayTypes: readonly ShareRow[];
	/** Lowest and highest shown share across the periods of the day, with every period at the lowest. */
	readonly spread: {
		readonly low: number;
		readonly high: number;
		readonly lowest: readonly string[];
	} | null;
}

function onTimeShare(row: PeriodComparisonRow): ShareRow {
	const readings = row.observationCount;
	const none = { key: row.grain, percent: null, readings: null };
	// No share exists without readings; a published count must be whole.
	if (readings != null && (!isCount(readings) || readings === 0)) return none;
	if (row.onTime != null) {
		const percent = readings == null ? null : countShare(row.onTime, readings, 0);
		return percent == null ? none : { key: row.grain, percent, readings };
	}
	const published = row.otpPct;
	if (published == null || !Number.isInteger(published) || published < 0 || published > 100)
		return none;
	return { key: row.grain, percent: published + 0, readings };
}

const ordered = (rows: readonly PeriodComparisonRow[], order: readonly string[]) =>
	rows
		.filter((row) => order.includes(row.grain))
		.sort((a, b) => order.indexOf(a.grain) - order.indexOf(b.grain))
		.map(onTimeShare);

/** The on-time share of readings for each period of the day and each day type, in time order. */
export function selectTimeOfDay(
	byShift: readonly PeriodComparisonRow[],
	byDayType: readonly PeriodComparisonRow[],
): TimeOfDay {
	const periods = ordered(byShift, SHIFT_GRAIN_ORDER);
	const shown = periods.filter((row): row is ShareRow & { percent: number } => row.percent != null);
	let spread: TimeOfDay['spread'] = null;
	if (shown.length >= 2) {
		const low = Math.min(...shown.map((row) => row.percent));
		const high = Math.max(...shown.map((row) => row.percent));
		spread = {
			low,
			high,
			lowest: shown.filter((row) => row.percent === low).map((row) => row.key),
		};
	}
	return { periods, dayTypes: ordered(byDayType, DAY_TYPE_GRAIN_ORDER), spread };
}

export interface StopDelayRow {
	readonly id: string;
	readonly name: string | null;
	/** Share of the stop's readings more than 5 minutes late, in tenths of a percent. */
	readonly percent: number;
	readonly readings: number | null;
}

/**
 * The stops the published ranking selected, listed by the share shown beside them, most late
 * first; more readings, then the published order, break ties. The published bounds belong to the
 * complementary share (readings not more than 5 minutes late), so none is carried beside this one.
 */
export function selectStopDelays(stops: readonly WeakStop[]): StopDelayRow[] {
	const rows: StopDelayRow[] = [];
	for (const stop of stops) {
		const share = stop.severe_pct;
		if (typeof share !== 'number' || !Number.isFinite(share) || share < 0 || share > 100) continue;
		rows.push({
			id: stop.id,
			name: stop.name ?? null,
			percent: Math.round(share * 10) / 10 + 0,
			readings: isCount(stop.observation_count) ? stop.observation_count : null,
		});
	}
	return rows
		.map((row, index) => ({ row, index }))
		.sort(
			(a, b) =>
				b.row.percent - a.row.percent ||
				(b.row.readings ?? -1) - (a.row.readings ?? -1) ||
				a.index - b.index,
		)
		.map(({ row }) => row);
}

export interface CountedShare {
	readonly count: number;
	readonly total: number;
	/** Tenths of a percent, from the two sums. */
	readonly percent: number;
	/** Days of the period with published counts. */
	readonly days: number;
}

export interface TripFacts {
	readonly cancelled: CountedShare | null;
	readonly skipped: CountedShare | null;
}

function summed<T extends { readonly date?: string | null }>(
	rows: readonly T[],
	period: RecordPeriod | null,
	part: (row: T) => number | null | undefined,
	whole: (row: T) => number | null | undefined,
): CountedShare | null {
	if (!period) return null;
	let count = 0;
	let total = 0;
	const days = new Set<string>();
	for (const row of rows) {
		if (!row.date || row.date < period.from || row.date > period.to) continue;
		const p = part(row);
		const w = whole(row);
		if (p == null && w == null) continue;
		// One row that breaks its definition withholds the period rather than skewing it.
		if (!isCount(p) || !isCount(w) || p > w) return null;
		count += p;
		total += w;
		days.add(row.date);
	}
	const percent = countShare(count, total, 1);
	return percent == null ? null : { count, total, percent, days: days.size };
}

/** Cancelled trips among those seen in the live data, and skipped stop updates, over the record's days. */
export function selectTripFacts(
	cancellations: readonly CancellationPeriod[],
	skipped: readonly SkippedStopPeriod[],
	period: RecordPeriod | null,
): TripFacts {
	return {
		cancelled: summed(
			cancellations,
			period,
			(row) => row.canceled_trip_days,
			(row) => row.total_trip_days,
		),
		skipped: summed(
			skipped,
			period,
			(row) => row.skipped_stop_count,
			(row) => row.stop_time_update_count,
		),
	};
}

export interface CrowdingFigure {
	readonly mix: CrowdingVM['mix'];
	/** The days `mix` covers, in words; null exactly when no mix is shown. */
	readonly scope: string | null;
}

/**
 * The occupancy mix a crowding figure shows and the days it covers, chosen together. A grain
 * shows only its own mix, named by the grain; the file-level mix is never shown under a grain's
 * name. A chosen range shows the mix of its retained days with the range's dates (the page
 * replaces the file's mix with them); without those dates nothing is shown.
 */
export function crowdingFigure(
	crowding: Pick<CrowdingVM, 'mix' | 'mixByGrain'>,
	mode: RecordMode,
	labels: { readonly grain: string; readonly range: string | null },
): CrowdingFigure {
	const none = { mix: null, scope: null };
	if (mode === 'range') {
		const mix = crowding.mixByGrain ?? crowding.mix;
		return mix && labels.range ? { mix, scope: labels.range } : none;
	}
	return crowding.mixByGrain ? { mix: crowding.mixByGrain, scope: labels.grain } : none;
}
