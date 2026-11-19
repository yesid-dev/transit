import type { HotspotEntry } from '#lib/v1/schemas/index.ts';
import type { Locale } from '#lib/i18n/index.ts';
import { intl } from '#lib/i18n/index.ts';

/** The publisher's eligibility floor (MIN_N_HOTSPOT): ranked rows have at least this many readings. */
export const READING_FLOOR = 30;
/** The publisher's ranked-row cap per kind and period (HOTSPOTS_BY_GRAIN_CAP). */
export const RANKED_CAP = 50;
/**
 * The publisher's cap on rows below the floor per period (HOTSPOTS_TRAY_CAP), lines and stops
 * together: one kind alone can fill it.
 */
export const TRAY_CAP = 60;

export type RankingKind = 'route' | 'stop';

/** One published period of a ranking, as the hotspots file carries it (current or a retained day). */
export interface HotspotGrainSource {
	readonly date?: string | null;
	readonly window_end?: string | null;
	readonly entries?: readonly HotspotEntry[];
	readonly tray?: readonly HotspotEntry[];
	readonly total_ranked_routes?: number | null;
	readonly total_ranked_stops?: number | null;
	readonly tray_total?: number | null;
}

/** Complete local days, both ends included. */
export interface RankingPeriod {
	readonly from: string;
	readonly to: string;
	readonly days: number;
}

export interface RankedRow {
	readonly key: string;
	readonly id: string;
	readonly name: string | null;
	/** The published position, 1-based and contiguous. */
	readonly position: number;
	/** Share of readings more than 5 minutes late, in percent; null when not published. */
	readonly latePct: number | null;
	readonly readings: number | null;
}

export interface BelowFloorRow {
	readonly key: string;
	readonly id: string;
	readonly name: string | null;
	readonly readings: number | null;
}

export interface BelowFloor {
	/** Rows of this kind under the floor; null unless the published list is complete. */
	readonly count: number | null;
	readonly examples: readonly BelowFloorRow[];
}

interface Published {
	readonly period: RankingPeriod | null;
	readonly belowFloor: BelowFloor;
}

/**
 * - `absent`: this period is not in the file.
 * - `invalid`: the published rows fail a math or order check, so none are shown.
 * - `none`: the period is published and no row of this kind ranks.
 * - `ranked`: rows in published order; `published` <= `eligible` when eligible is known.
 */
export type HotspotRanking =
	| { readonly state: 'absent' }
	| ({ readonly state: 'invalid' } & Published)
	| ({ readonly state: 'none' } & Published)
	| ({
			readonly state: 'ranked';
			readonly rows: readonly RankedRow[];
			readonly published: number;
			readonly eligible: number | null;
	  } & Published);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
// The publisher rounds the share half away from zero to one decimal.
const ROUNDING = 0.05 + 1e-9;

function dayNumber(value: string | null | undefined): number | null {
	if (value == null || !ISO_DAY.test(value)) return null;
	const time = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(time) && new Date(time).toISOString().startsWith(value)
		? time / DAY_MS
		: null;
}

function readPeriod(grain: HotspotGrainSource): RankingPeriod | null {
	const from = dayNumber(grain.date);
	const to = dayNumber(grain.window_end);
	if (from == null || to == null || to < from) return null;
	return { from: grain.date!, to: grain.window_end!, days: to - from + 1 };
}

const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isShare = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
// Counts and shares reach the page as +0, never -0 (owner ruling 6).
const positiveZero = (value: number | null | undefined): number | null =>
	value == null ? null : value + 0;
const optional = <T>(value: T | null | undefined, valid: (value: T) => boolean): boolean =>
	value == null || valid(value);

/** Every figure of a ranked row obeys its definition, or the row is not a ranked row. */
function rowIsSane(entry: HotspotEntry): boolean {
	const readings = entry.observation_count;
	const late = entry.severe_count;
	if (!optional(readings, isCount) || !optional(late, isCount)) return false;
	if (readings != null && readings < READING_FLOOR) return false;
	if (readings != null && late != null && late > readings) return false;
	if (!optional(entry.severe_pct, isShare)) return false;
	if (
		entry.severe_pct != null &&
		readings != null &&
		late != null &&
		Math.abs(entry.severe_pct - (100 * late) / readings) > ROUNDING
	)
		return false;
	const lo = entry.wilson_lo;
	const hi = entry.wilson_hi;
	if (!optional(lo, isShare) || !optional(hi, isShare)) return false;
	return lo == null || hi == null || lo <= hi;
}

/** Positions 1..n with no gap, and the published bound never contradicts them. */
function orderIsSane(rows: readonly HotspotEntry[]): boolean {
	let bound = -Infinity;
	return rows.every((row, index) => {
		if (row.rank !== index + 1) return false;
		if (row.wilson_lo == null) return true;
		if (row.wilson_lo < bound) return false;
		bound = row.wilson_lo;
		return true;
	});
}

function readBelowFloor(grain: HotspotGrainSource, kind: RankingKind): BelowFloor {
	const tray = grain.tray ?? [];
	const sane = tray.every(
		(entry) =>
			optional(entry.observation_count, isCount) && (entry.observation_count ?? 0) < READING_FLOOR,
	);
	if (!sane) return { count: null, examples: [] };
	const examples = tray
		.filter((entry) => entry.type === kind)
		.map((entry) => ({
			key: `${kind}-${entry.id}`,
			id: entry.id,
			name: entry.name?.trim() || null,
			readings: positiveZero(entry.observation_count),
		}));
	const complete = isCount(grain.tray_total) && grain.tray_total === tray.length;
	return { count: complete ? examples.length : null, examples };
}

/** Reads one kind of one published period, refusing figures that break their own definitions. */
export function readHotspotRanking(
	grain: HotspotGrainSource | null | undefined,
	kind: RankingKind,
): HotspotRanking {
	if (grain == null) return { state: 'absent' };
	const published: Published = {
		period: readPeriod(grain),
		belowFloor: readBelowFloor(grain, kind),
	};
	const entries = (grain.entries ?? [])
		.filter((entry) => entry.type === kind)
		.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
	const total = kind === 'route' ? grain.total_ranked_routes : grain.total_ranked_stops;
	if (!entries.every(rowIsSane) || !orderIsSane(entries) || !optional(total, isCount))
		return { state: 'invalid', ...published };
	const eligible = positiveZero(total);
	if (eligible != null && eligible < entries.length) return { state: 'invalid', ...published };
	if (entries.length === 0) return { state: 'none', ...published };
	return {
		state: 'ranked',
		...published,
		published: entries.length,
		eligible,
		rows: entries.map((entry) => ({
			key: `${kind}-${entry.id}`,
			id: entry.id,
			name: entry.name?.trim() || null,
			position: entry.rank!,
			latePct: positiveZero(entry.severe_pct),
			readings: positiveZero(entry.observation_count),
		})),
	};
}

function dayParts(value: string, locale: Locale) {
	const parts = intl
		.dateTime(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
		.formatToParts(new Date(`${value}T00:00:00Z`));
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((item) => item.type === type)?.value ?? '';
	const day = part('day');
	return {
		day: locale === 'fr' && day === '1' ? '1er' : day,
		month: part('month'),
		year: part('year'),
	};
}

/** "November 4 to 10, 2026" / "Du 4 au 10 novembre 2026", both ends included. */
export function formatDayRange(from: string, to: string, locale: Locale): string {
	const a = dayParts(from, locale);
	const b = dayParts(to, locale);
	if (locale === 'fr') {
		if (from === to) return `Le ${a.day} ${a.month} ${a.year}`;
		const start =
			a.year !== b.year
				? `${a.day} ${a.month} ${a.year}`
				: a.month !== b.month
					? `${a.day} ${a.month}`
					: a.day;
		return `Du ${start} au ${b.day} ${b.month} ${b.year}`;
	}
	if (from === to) return `${a.month} ${a.day}, ${a.year}`;
	if (a.year !== b.year) return `${a.month} ${a.day}, ${a.year} to ${b.month} ${b.day}, ${b.year}`;
	if (a.month !== b.month) return `${a.month} ${a.day} to ${b.month} ${b.day}, ${b.year}`;
	return `${a.month} ${a.day} to ${b.day}, ${b.year}`;
}
