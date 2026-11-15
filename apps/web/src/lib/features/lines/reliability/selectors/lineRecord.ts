import type { RouteReliability } from '#lib/v1/index.ts';
import { routeClosedThrough, trailingRouteWindow } from '#lib/v1/closedWindow.ts';
import {
	selectVerdictWindow,
	VERDICT_MIN_N,
	VERDICT_PATCHY_FLOOR,
	type ReliabilityVerdict,
} from '#lib/v1/verdict.ts';

export type RecordMode = 'day' | 'week' | 'month' | 'range';

/** The complete days a record answer covers, inclusive. */
export interface RecordPeriod {
	readonly from: string;
	readonly to: string;
	readonly days: number;
}

export type RecordClassification = 'reliable' | 'uneven' | 'unreliable' | 'uncertain' | 'too-few';

export type LineRecordAnswer =
	| { readonly kind: 'absent' }
	| {
			readonly kind: 'figure';
			/** Whole percent of readings on time. */
			readonly percent: number;
			/** Readings behind the figure, or null when the result does not publish them. */
			readonly readings: number | null;
			/** The same measure's uncertainty range, whole percent, containing `percent`. */
			readonly interval: { readonly lo: number; readonly hi: number } | null;
			readonly classification: RecordClassification;
	  };

export interface LineRecord {
	readonly period: RecordPeriod | null;
	readonly answer: LineRecordAnswer;
}

export interface LineRecordInput {
	/** The file the page shows for the chosen period. */
	readonly data: RouteReliability;
	/** The view's one verdict for that period; this module never computes a second one. */
	readonly verdict: ReliabilityVerdict;
	readonly mode: RecordMode;
	readonly range?: { readonly from: string; readonly to: string } | null;
}

const DAY_MS = 86_400_000;

const isCount = (value: number | null | undefined): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0;

function period(from: string, to: string): RecordPeriod | null {
	const [lo, hi] = from <= to ? [from, to] : [to, from];
	const span = (Date.parse(`${hi}T00:00:00Z`) - Date.parse(`${lo}T00:00:00Z`)) / DAY_MS;
	return Number.isInteger(span) ? { from: lo, to: hi, days: span + 1 } : null;
}

function recordPeriod({ data, mode, range }: LineRecordInput): RecordPeriod | null {
	if (mode === 'range') return range ? period(range.from, range.to) : null;
	if (mode === 'week' || mode === 'month') {
		const window = trailingRouteWindow(data, mode)?.window;
		return window ? period(window.from, window.to) : null;
	}
	const day = selectVerdictWindow(data.periods ?? [], 'day', undefined, routeClosedThrough(data));
	return day?.grain === 'day' && day.date ? period(day.date, day.date) : null;
}

/** Whole percent, rounded half up, from integer counts: no floating-point tolerance. */
const percentOf = (onTime: number, readings: number): number =>
	Math.floor((200 * onTime + readings) / (2 * readings));

function classify(
	verdict: ReliabilityVerdict,
	percent: number,
	readings: number | null,
): RecordClassification {
	if (verdict.status === 'reliable') return 'reliable';
	// Both bands sit wholly below 80%; the shown figure decides which one it is.
	if (verdict.status === 'patchy' || verdict.status === 'unreliable')
		return percent >= VERDICT_PATCHY_FLOOR ? 'uneven' : 'unreliable';
	return readings != null && readings < VERDICT_MIN_N ? 'too-few' : 'uncertain';
}

function answer({ verdict }: LineRecordInput): LineRecordAnswer {
	const { observationCount: readings, onTime } = verdict;
	if (verdict.status === 'absent') return { kind: 'absent' };
	// A published reading count must be whole and at least one: no share exists without readings.
	if (readings != null && (!isCount(readings) || readings === 0)) return { kind: 'absent' };
	let percent: number | null;
	if (onTime != null) {
		// With both counts published, they define the share: on time <= readings, whole.
		if (readings == null || !isCount(onTime) || onTime > readings) return { kind: 'absent' };
		percent = percentOf(onTime, readings);
	} else {
		percent = verdict.otpPct;
	}
	if (percent == null || !Number.isFinite(percent) || percent < 0 || percent > 100)
		return { kind: 'absent' };
	percent = Math.round(percent) + 0;
	const bounds = verdict.interval;
	const interval =
		bounds != null &&
		Number.isInteger(bounds.lo) &&
		Number.isInteger(bounds.hi) &&
		0 <= bounds.lo &&
		bounds.lo <= percent &&
		percent <= bounds.hi &&
		bounds.hi <= 100
			? { lo: bounds.lo + 0, hi: bounds.hi + 0 }
			: null;
	return {
		kind: 'figure',
		percent,
		readings,
		interval,
		classification: classify(verdict, percent, readings),
	};
}

/**
 * The line's record answer for the chosen period: its dates, the on-time share of its readings,
 * the readings behind it, the same measure's uncertainty range and Transit's classification.
 * Anything that breaks its own definition is withheld rather than shown.
 */
export function selectLineRecord(input: LineRecordInput): LineRecord {
	return { period: recordPeriod(input), answer: answer(input) };
}

/**
 * The record's own link: the page it is on, its provider, the Record view (the bare URL) and the
 * exact complete days it covers, so a copied link keeps showing the same days.
 */
export function recordLink(
	url: {
		readonly origin: string;
		readonly pathname: string;
		readonly searchParams: Iterable<[string, string]>;
	},
	providerId: string | null,
	period: RecordPeriod | null,
): string {
	const next = new URL(url.pathname, url.origin);
	const replaced = new Set(period ? ['tab', 'grain', 'from', 'to'] : ['tab']);
	for (const [key, value] of url.searchParams)
		if (!replaced.has(key)) next.searchParams.append(key, value);
	if (providerId) next.searchParams.set('provider', providerId);
	if (period) {
		next.searchParams.set('from', period.from);
		next.searchParams.set('to', period.to);
	}
	return next.href;
}

/** Who a record is about, for its link and its citation. */
export interface RecordCitation {
	readonly line: string;
	readonly providerId: string;
	readonly providerName: string;
}

/** Which published record a figure comes from; a field is null when it is not supplied. */
export interface RecordPublication {
	readonly generatedUtc: string | null;
	readonly generationId: string | null;
	readonly methodVersion: string | null;
}

interface PublicationSource {
	readonly generated_utc?: string | null;
	readonly publish_generation_id?: string | null;
	readonly methodology_version?: string | null;
}

/**
 * The publication identity shared by every source of a figure: one file, or the retained
 * partitions a chosen range was built from. A field the sources disagree on, or do not supply,
 * stays null rather than being borrowed from another publication.
 */
export function sharedPublication(sources: readonly PublicationSource[]): RecordPublication {
	const shared = (pick: (source: PublicationSource) => string | null | undefined) => {
		const values = new Set(sources.map((source) => pick(source)?.trim() || null));
		const [only] = values;
		return values.size === 1 && only ? only : null;
	};
	return {
		generatedUtc: shared((source) => source.generated_utc),
		generationId: shared((source) => source.publish_generation_id),
		methodVersion: shared((source) => source.methodology_version),
	};
}
