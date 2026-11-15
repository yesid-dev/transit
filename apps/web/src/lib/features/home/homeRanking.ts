import { MIN_N_RATE } from '#lib/v1/stats.ts';
import {
	createPublishedWeeklyRanking,
	weeklyPublicationDeadline,
} from '#lib/v1/ranking/published.ts';
import type { HotspotEntry, Hotspots } from '#lib/v1/schemas/generated/historic_hotspots.ts';
import { stopDisplayName } from '#lib/site/transitDisplay.ts';
import type { LineDirectory } from '#lib/site/lineDirectory.ts';
import type { RecordWeek } from './homeRecord';

/** One place to investigate: its share of readings more than 5 minutes late, and its readings. */
export interface InvestigateRow {
	readonly kind: 'line' | 'stop';
	readonly id: string;
	/** A line's number, drawn as its plate; null for a stop or a line the index does not know. */
	readonly number: string | null;
	/** What follows the plate: the line's name (null when the plate says it all), or the stop's. */
	readonly name: string | null;
	/** The complete visible identity. */
	readonly label: string;
	/** The identity as a screen reader says it. */
	readonly spoken: string;
	/** Share of the place's readings more than 5 minutes late, 0 to 100, as published. */
	readonly latePct: number;
	/** Whole count of the readings behind the share, at least the rate floor. */
	readonly readings: number;
}

/**
 * A ranking preview with its own seven dates. `not-current` covers a file past its publication
 * window, a week whose dates cannot be named and a week where no place qualifies: absence, never
 * an empty reassurance. Rows are ordered by the share they show, highest first (owner ruling 6).
 */
export type InvestigateList =
	| {
			readonly state: 'ranked';
			readonly window: RecordWeek;
			readonly days: number;
			readonly rows: readonly InvestigateRow[];
	  }
	| { readonly state: 'not-current' }
	| { readonly state: 'unpublished' };

interface Options {
	readonly now?: number;
	readonly limit?: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
const WEEK_DAYS = 7;

function dateKey(value: unknown): number | null {
	if (typeof value !== 'string' || !DATE.test(value)) return null;
	const time = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

/** A share of readings and its readings, or null when either falls outside its definition. */
function figures(share: unknown, readings: unknown): { latePct: number; readings: number } | null {
	if (typeof share !== 'number' || !Number.isFinite(share) || share < 0 || share > 100) return null;
	if (!Number.isSafeInteger(readings) || (readings as number) < MIN_N_RATE) return null;
	// + 0 turns a published -0 into 0: no negative zero (owner ruling 6).
	return { latePct: share + 0, readings: (readings as number) + 0 };
}

function byShownShare(a: InvestigateRow, b: InvestigateRow): number {
	return (
		b.latePct - a.latePct || b.readings - a.readings || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
}

/** Highest shares first, under the week's own dates. */
function preview(
	rows: readonly InvestigateRow[],
	from: unknown,
	to: unknown,
	limit: number,
): InvestigateList {
	const start = dateKey(from);
	const end = dateKey(to);
	// Both previews are weekly: seven named calendar days, or no dates to state.
	if (start == null || end == null || (end - start) / DAY + 1 !== WEEK_DAYS)
		return { state: 'not-current' };
	const shown = [...rows].sort(byShownShare).slice(0, limit);
	if (!shown.length) return { state: 'not-current' };
	return {
		state: 'ranked',
		window: { from: from as string, to: to as string },
		days: WEEK_DAYS,
		rows: shown,
	};
}

function isLine(entry: HotspotEntry): boolean {
	const kind = entry.type.toLowerCase();
	return kind === 'route' || kind === 'line';
}

/** The published week's lines with the highest late shares, from the hotspots file. */
export function lineList(
	hotspots: Hotspots | null | undefined,
	directory: LineDirectory,
	{ now = Date.now(), limit = 3 }: Options = {},
): InvestigateList {
	const week = hotspots?.by_grain?.find((window) => window.grain === 'week');
	if (!hotspots || !week) return { state: 'unpublished' };
	const generated = Date.parse(hotspots.generated_utc);
	if (
		!Number.isFinite(generated) ||
		!Number.isFinite(now) ||
		generated > now ||
		now >= weeklyPublicationDeadline(generated)
	)
		return { state: 'not-current' };
	// A published file is outside input: the best-ranked of a repeated id is the one kept.
	const firsts = new Map<string, HotspotEntry>();
	const byRank = [...(week.entries ?? [])].sort(
		(a, b) => (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY),
	);
	for (const entry of byRank)
		if (isLine(entry) && !firsts.has(entry.id)) firsts.set(entry.id, entry);
	const rows = [...firsts.values()].flatMap((entry): InvestigateRow[] => {
		const shown = figures(entry.severe_pct, entry.observation_count);
		if (!shown) return [];
		const named = directory.name(entry.id, entry.name ?? null);
		return [
			{
				kind: 'line',
				id: entry.id,
				number: named.number,
				name: named.number ? (named.name !== named.number ? named.name : null) : named.label,
				label: named.label,
				spoken: named.spoken,
				...shown,
			},
		];
	});
	return preview(rows, week.date, week.window_end, limit);
}

/** The published week's stops with the highest late shares, from the weekly reliability index. */
export function stopList(
	index: unknown,
	{ now = Date.now(), limit = 3 }: Options = {},
): InvestigateList {
	const published = (index as { weekly_stops?: unknown } | null | undefined)?.weekly_stops;
	if (!Array.isArray(published) || published.length === 0) return { state: 'unpublished' };
	const weekly = createPublishedWeeklyRanking(index)('stop', now);
	if (!weekly) return { state: 'not-current' };
	const ranked = weekly.filter((row) => row.state === 'ranked');
	const window = ranked[0];
	// One list, one week: rows from another week would sit under the wrong dates.
	if (
		!window ||
		ranked.some(
			(row) => row.window_start !== window.window_start || row.window_end !== window.window_end,
		)
	)
		return { state: 'not-current' };
	const rows = ranked.flatMap((row): InvestigateRow[] => {
		if (row.numerator == null || row.denominator == null || row.numerator > row.denominator)
			return [];
		const shown = figures(row.severe_pct, row.denominator);
		if (!shown) return [];
		const name = row.name?.trim() ? stopDisplayName(row.name.trim()) : row.id;
		return [{ kind: 'stop', id: row.id, number: null, name, label: name, spoken: name, ...shown }];
	});
	return preview(rows, window.window_start, window.window_end, limit);
}
