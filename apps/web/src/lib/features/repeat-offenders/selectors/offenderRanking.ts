import type { RepeatOffenderEntry } from '#lib/v1/schemas/index.ts';
import type { RankingPeriod } from '#lib/features/hotspots/selectors/hotspotRanking.ts';
import { lateShareInterval, type LateShareInterval } from './offenderEvidence';

/** The publisher's rule (#1048, #1080): a ranked row has all three. */
export const READING_FLOOR = 30;
export const OBSERVED_DAYS_FLOOR = 3;
export const LATE_DAYS_FLOOR = 2;

export type OffenderKind = 'trip' | 'vehicle';
/** A published count below its floor. */
export type MeasuredReason = 'readings' | 'observedDays' | 'lateDays';
/** Which part of the rule a not-ranked row misses, or cannot show because a count is unpublished. */
export type UnrankedReason =
	| MeasuredReason
	| 'readingsUnknown'
	| 'observedDaysUnknown'
	| 'lateDaysUnknown';

/** One published period of the repeat-offenders file (current or a retained day). */
export interface OffenderGrainSource {
	readonly date?: string | null;
	readonly window_end?: string | null;
	readonly window_days?: number | null;
	readonly entries?: readonly RepeatOffenderEntry[];
	readonly tray?: readonly RepeatOffenderEntry[];
	readonly total_ranked_trips?: number | null;
	readonly total_ranked_vehicles?: number | null;
	readonly tray_total?: number | null;
}

/** A row's published figures, each checked against its definition; null when not published. */
export interface OffenderFigures {
	readonly readings: number | null;
	readonly lateReadings: number | null;
	/** Share of readings more than 5 minutes late, in percent. */
	readonly latePct: number | null;
	readonly interval: LateShareInterval | null;
	/** Days with at least one reading more than 5 minutes late. */
	readonly lateDays: number | null;
	readonly observedDays: number | null;
	readonly windowDays: number | null;
	readonly averageDelayMin: number | null;
}

export interface OffenderRow {
	readonly key: string;
	readonly entry: RepeatOffenderEntry;
	readonly figures: OffenderFigures;
}
export interface RankedOffender extends OffenderRow {
	/** The publisher's position. */
	readonly position: number;
}
export interface UnrankedOffender extends OffenderRow {
	readonly reasons: readonly UnrankedReason[];
}

interface Published {
	readonly period: RankingPeriod | null;
	readonly windowDays: number | null;
	readonly unranked: {
		readonly rows: readonly UnrankedOffender[];
		/** The record lists every not-ranked row it counts (both kinds together). */
		readonly complete: boolean;
	};
	/** Some published positions predate the current rule; those rows are listed as not ranked. */
	readonly earlierRule: boolean;
}

/**
 * - `absent`: this period is not in the file.
 * - `invalid`: a published figure or the order fails its check, so nothing is shown.
 * - `none`: the period is published and no row of this kind meets the rule.
 * - `ranked`: rows in the publisher's order; `published` <= `eligible` when eligible is known.
 */
export type OffenderRanking =
	| { readonly state: 'absent' }
	| {
			readonly state: 'invalid';
			readonly period: RankingPeriod | null;
			readonly windowDays: number | null;
	  }
	| ({ readonly state: 'none' } & Published)
	| ({
			readonly state: 'ranked';
			readonly rows: readonly RankedOffender[];
			readonly published: number;
			readonly eligible: number | null;
	  } & Published);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
// Published bounds and the share are each rounded to a tenth; their difference can carry both.
const BOUND_SLACK = 0.1 + 1e-9;

function dayNumber(value: string | null | undefined): number | null {
	if (value == null || !ISO_DAY.test(value)) return null;
	const time = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(time) && new Date(time).toISOString().startsWith(value)
		? time / DAY_MS
		: null;
}

const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isShare = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const optional = <T>(value: T | null | undefined, valid: (value: T) => boolean): boolean =>
	value == null || valid(value);
// Figures reach the page as +0, never -0 (owner ruling 6).
const positiveZero = (value: number | null | undefined): number | null =>
	value == null ? null : value + 0;

/** The publisher's share in tenths of a percent: 1000 × late / readings, half away from zero. */
const shareTenths = (late: number, readings: number): number =>
	Math.floor((2000 * late + readings) / (2 * readings));

/** Every figure obeys its definition, or the row is not shown (owner ruling 6). */
function rowIsSane(entry: RepeatOffenderEntry, windowDays: number | null): boolean {
	const readings = entry.observation_count;
	const late = entry.severe_count;
	const lateDays = entry.recurrence_days;
	const observed = entry.observed_days;
	const window = entry.window_days ?? windowDays;
	if (![readings, late, lateDays, observed].every((value) => optional(value, isCount)))
		return false;
	if (entry.window_days != null) {
		if (!isCount(entry.window_days) || entry.window_days < 1) return false;
		if (windowDays != null && entry.window_days !== windowDays) return false;
	}
	if (readings != null && late != null && late > readings) return false;
	if (lateDays != null && observed != null && lateDays > observed) return false;
	if (observed != null && window != null && observed > window) return false;
	if (readings != null && observed != null && observed > readings) return false;
	if (readings != null && readings > 0 && observed === 0) return false;
	if (late != null && lateDays != null && late > 0 !== lateDays > 0) return false;
	if (late != null && lateDays != null && lateDays > late) return false;
	const pct = entry.severe_pct;
	if (!optional(pct, isShare)) return false;
	if (pct != null && readings === 0) return false;
	if (pct != null && readings != null && readings > 0 && late != null) {
		const tenths = shareTenths(late, readings);
		if (Math.abs(pct * 10 - tenths) > 1e-6) return false;
	}
	if (!optional(entry.avg_delay_min, Number.isFinite)) return false;
	const lo = entry.wilson_lo;
	const hi = entry.wilson_hi;
	if ((lo == null) !== (hi == null)) return false;
	if (!optional(lo, isShare) || !optional(hi, isShare)) return false;
	if (lo != null && hi != null) {
		if (lo > hi) return false;
		const interval = lateShareInterval(lo, hi)!;
		if (pct != null && (pct < interval.lower - BOUND_SLACK || pct > interval.upper + BOUND_SLACK))
			return false;
	}
	return true;
}

function figuresOf(entry: RepeatOffenderEntry, windowDays: number | null): OffenderFigures {
	return {
		readings: positiveZero(entry.observation_count),
		lateReadings: positiveZero(entry.severe_count),
		latePct: positiveZero(entry.severe_pct),
		interval: lateShareInterval(entry.wilson_lo, entry.wilson_hi),
		lateDays: positiveZero(entry.recurrence_days),
		observedDays: positiveZero(entry.observed_days),
		windowDays: positiveZero(entry.window_days ?? windowDays),
		averageDelayMin: positiveZero(entry.avg_delay_min),
	};
}

/** True when the reason is a published count below its floor, not an unpublished one. */
export const isMeasured = (reason: UnrankedReason): reason is MeasuredReason =>
	!reason.endsWith('Unknown');

/**
 * The parts of the rule a row misses. An unpublished count cannot meet the rule, but it is not
 * a count below the floor either: it gets its own reason.
 */
function missedRule(entry: RepeatOffenderEntry): UnrankedReason[] {
	const checks = [
		[entry.observation_count, READING_FLOOR, 'readings'],
		[entry.observed_days, OBSERVED_DAYS_FLOOR, 'observedDays'],
		[entry.recurrence_days, LATE_DAYS_FLOOR, 'lateDays'],
	] as const;
	return checks.flatMap(([value, floor, reason]): UnrankedReason[] =>
		value == null ? [`${reason}Unknown`] : value < floor ? [reason] : [],
	);
}

/** More late days first; on equal late days, the longer average delay first. */
function orderIsSane(rows: readonly RepeatOffenderEntry[]): boolean {
	return rows.every((row, index) => {
		if (index === 0) return true;
		const before = rows[index - 1];
		const [a, b] = [before.recurrence_days ?? 0, row.recurrence_days ?? 0];
		if (b !== a) return b < a;
		const [x, y] = [before.avg_delay_min, row.avg_delay_min];
		return x == null || y == null || y <= x;
	});
}

const keyOf = (entry: RepeatOffenderEntry) => `${entry.type}-${entry.id}-${entry.route ?? ''}`;

/**
 * Reads one kind of one published period. Rows keep the publisher's order and positions; a
 * figure that breaks its own definition refuses the whole ranking. Rows placed by an earlier
 * rule, which the current rule would not rank, are listed as not ranked rather than reordered.
 */
export function readOffenderRanking(
	grain: OffenderGrainSource | null | undefined,
	kind: OffenderKind,
): OffenderRanking {
	if (grain == null) return { state: 'absent' };
	const from = dayNumber(grain.date);
	const to = dayNumber(grain.window_end);
	const period =
		from != null && to != null && to >= from
			? { from: grain.date!, to: grain.window_end!, days: to - from + 1 }
			: null;
	const declared = isCount(grain.window_days) && grain.window_days > 0 ? grain.window_days : null;
	const windowDays = declared ?? period?.days ?? null;
	const refused = { state: 'invalid' as const, period, windowDays };
	if (grain.window_days != null && declared == null) return refused;
	if (period && declared != null && period.days !== declared) return refused;

	const entries = (grain.entries ?? [])
		.filter((entry) => entry.type === kind)
		.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
	const tray = (grain.tray ?? []).filter((entry) => entry.type === kind);
	const total = kind === 'trip' ? grain.total_ranked_trips : grain.total_ranked_vehicles;
	if (
		![...entries, ...tray].every((entry) => rowIsSane(entry, windowDays)) ||
		!entries.every((entry, index) => entry.rank === index + 1) ||
		!tray.every((entry) => entry.rank == null) ||
		!optional(total, isCount) ||
		!optional(grain.tray_total, isCount)
	)
		return refused;

	const meets = entries.filter((entry) => missedRule(entry).length === 0);
	const earlierRule = meets.length < entries.length;
	if (!earlierRule && !orderIsSane(meets)) return refused;
	const eligible = earlierRule ? null : positiveZero(total);
	if (eligible != null && eligible < meets.length) return refused;

	const unranked = [...entries.filter((entry) => !meets.includes(entry)), ...tray].map((entry) => ({
		key: keyOf(entry),
		entry,
		figures: figuresOf(entry, windowDays),
		reasons: missedRule(entry),
	}));
	const published: Published = {
		period,
		windowDays,
		earlierRule,
		unranked: {
			rows: unranked,
			complete: isCount(grain.tray_total) && grain.tray_total === (grain.tray ?? []).length,
		},
	};
	if (meets.length === 0) return { state: 'none', ...published };
	return {
		state: 'ranked',
		...published,
		published: meets.length,
		eligible,
		rows: meets.map((entry) => ({
			key: keyOf(entry),
			entry,
			position: entry.rank!,
			figures: figuresOf(entry, windowDays),
		})),
	};
}
