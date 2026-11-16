import type { RouteIndexEntry } from '#lib/v1/index.ts';
import type { RouteReliabilityIndex } from '#lib/v1/schemas/route_reliability_index.ts';
import type { ReliabilitySnapshot } from '#lib/v1/reliabilitySnapshot.svelte.ts';
import {
	isProblemVerdict,
	VERDICT_MIN_N,
	type VerdictCopy,
	type VerdictStatus,
} from '#lib/v1/verdict.ts';
import { selectDirectoryRecord, type DirectoryComparison } from './directoryEvidence';
import type {
	RecordClassification,
	RecordPeriod,
	RecordPublication,
} from './reliability/selectors/lineRecord';

type WeeklyEntry = NonNullable<RouteReliabilityIndex['weekly_routes']>[number];
export type WeeklyUnrankedState = Exclude<WeeklyEntry['state'], 'ranked'>;

/** Twenty rows at first, then explicit twenty-row increments: the last one states its real size. */
export const DIRECTORY_PAGE_SIZE = 20;

export type DirectoryOrder = 'number' | 'comparison';
export type DirectoryStatus = 'all' | 'problem';

/** Everything the directory keeps in the URL, so Back and a refresh restore the same view. */
export interface DirectoryState {
	readonly query: string;
	readonly mode: string;
	readonly order: DirectoryOrder;
	readonly status: DirectoryStatus;
	readonly line: string | null;
	readonly shown: number;
}

const MODE_KEY = /^[a-z_]{1,24}$/u;

function text(value: string | null): string {
	return (value ?? '')
		.replace(/[\p{Cc}]+/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim()
		.slice(0, 80);
}

function positiveIncrement(value: string | null): number | null {
	if (!value || !/^\d{1,6}$/u.test(value)) return null;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
	// Only the increments the Show more control can produce are honoured; anything else is a hint
	// the control cannot have written, so the list starts at its first page instead.
	return parsed % DIRECTORY_PAGE_SIZE === 0 ? parsed : null;
}

/**
 * The directory's view state from the URL. A value the controls cannot produce is dropped to its
 * default rather than honoured: comparison order and the problem filter never mix, so a URL asking
 * for both resolves to the problem mode in line-number order.
 */
export function parseDirectoryState(params: URLSearchParams): DirectoryState {
	const status: DirectoryStatus = params.get('status') === 'problem' ? 'problem' : 'all';
	const order: DirectoryOrder =
		status === 'all' && params.get('sort') === 'worst' ? 'comparison' : 'number';
	const mode = params.get('mode');
	const line = params.get('line');
	return {
		query: text(params.get('q')),
		mode: mode && MODE_KEY.test(mode) ? mode : 'all',
		order,
		status,
		// IDs are opaque published values. The view checks membership before requesting a file;
		// route builders then URI-encode them rather than inventing a narrower ID alphabet here.
		line: line || null,
		shown: positiveIncrement(params.get('shown')) ?? DIRECTORY_PAGE_SIZE,
	};
}

/** The parameters to mirror; defaults stay absent so a plain visit keeps a clean URL. */
export function directorySearchParams(state: DirectoryState): Record<string, string | null> {
	return {
		q: state.query || null,
		mode: state.mode === 'all' ? null : state.mode,
		sort: state.order === 'comparison' ? 'worst' : null,
		status: state.status === 'problem' ? 'problem' : null,
		line: state.line,
		shown: state.shown > DIRECTORY_PAGE_SIZE ? String(state.shown) : null,
	};
}

/** How many rows the Show more control adds, and the last increment's real size. */
export function nextPageSize(shown: number, matching: number): number {
	return Math.min(DIRECTORY_PAGE_SIZE, Math.max(0, matching - shown));
}

export interface DirectoryLineHrefInput {
	/** The directory's own URL: its origin, locale prefix and unrelated parameters are kept. */
	readonly base: URL;
	/** The line's localized path, already resolved for the reader's locale. */
	readonly path: string;
	readonly providerId: string;
	/** The selected evidence's exact complete days, when it has them. */
	readonly from?: string | null;
	readonly to?: string | null;
	readonly days?: number | null;
}

const DIRECTORY_ONLY_PARAMS = [
	'q',
	'mode',
	'sort',
	'status',
	'line',
	'shown',
	'tab',
	'grain',
	'from',
	'to',
] as const;

/**
 * A line's Record (or Schedule) link, built from the directory's own URL: the reader's locale and
 * provider stay, the directory's own view state goes, and the link carries the selected evidence's
 * actual complete days — never the directory's current week when the evidence is another one.
 */
export function directoryLineHref(input: DirectoryLineHrefInput): string {
	const next = new URL(input.base.href);
	// The caller's path may already carry the reader's provider; only its pathname is used here.
	next.pathname = new URL(input.path, input.base.origin).pathname;
	for (const key of DIRECTORY_ONLY_PARAMS) next.searchParams.delete(key);
	next.searchParams.set('provider', input.providerId);
	if (input.from && input.to && input.days != null) {
		next.searchParams.set('from', input.from);
		next.searchParams.set('to', input.to);
	}
	return next.pathname + next.search;
}

/** The same link, opening the line's Schedule view. It never carries a record period. */
export function directoryScheduleHref(
	input: Omit<DirectoryLineHrefInput, 'from' | 'to' | 'days'>,
): string {
	const next = new URL(input.base.href);
	next.pathname = new URL(input.path, input.base.origin).pathname;
	for (const key of DIRECTORY_ONLY_PARAMS) next.searchParams.delete(key);
	next.searchParams.set('provider', input.providerId);
	next.searchParams.set('tab', 'schedule');
	return next.pathname + next.search;
}

/** A line's map view: the requested path with the reader's provider, nothing else. */
export function directoryProviderHref(
	input: Omit<DirectoryLineHrefInput, 'from' | 'to' | 'days'>,
): string {
	const next = new URL(input.path, input.base.origin);
	next.searchParams.set('provider', input.providerId);
	return next.pathname + next.search;
}

const NO_PUBLICATION: RecordPublication = {
	generatedUtc: null,
	generationId: null,
	methodVersion: null,
};

export type DirectoryEvidenceState =
	| 'figure'
	| 'uncertain'
	| 'low-sample'
	| 'not-published'
	| 'no-live'
	| 'loading'
	| 'failed'
	| 'unranked';

/**
 * One row's evidence, in the words and numbers the surface can defend: the record's own closed
 * week and readings for a current route file, or the published index entry's own window for a
 * compared row. A figure is only a figure when its own definition holds.
 */
export interface DirectoryEvidence {
	readonly state: DirectoryEvidenceState;
	/** The actual record source, independently of whether that source ranked the line. */
	readonly source: 'current_route_record' | 'published_weekly_index' | null;
	/** Whole percent of readings on time; never a stand-in for an absent figure. */
	readonly percent: number | null;
	readonly readings: number | null;
	readonly from: string | null;
	readonly to: string | null;
	readonly days: number | null;
	readonly publication: RecordPublication;
	/** The verdict's own sentence, when the row is uncertain or short of evidence. */
	readonly hedge: string | null;
	readonly verdictStatus: VerdictStatus | null;
	readonly classification: RecordClassification | null;
	/** The published state behind an excluded comparison row; never a figure. */
	readonly excluded: WeeklyUnrankedState | null;
	/** The entry ends before the compared week; a different later week is not called older. */
	readonly older: boolean;
}

const EMPTY_EVIDENCE: DirectoryEvidence = {
	state: 'loading',
	source: null,
	percent: null,
	readings: null,
	from: null,
	to: null,
	days: null,
	publication: NO_PUBLICATION,
	hedge: null,
	verdictStatus: null,
	classification: null,
	excluded: null,
	older: false,
};

function periodFields(period: RecordPeriod | null) {
	return {
		from: period?.from ?? null,
		to: period?.to ?? null,
		days: period?.days ?? null,
	};
}

/**
 * A current line's evidence from its own route file. Reading first, then the states that withhold
 * a figure: no live data by the provider policy, an unpublished record, fewer readings than the
 * published floor. Absence is never rendered as 0%.
 */
export function ordinaryEvidence(
	snapshot: ReliabilitySnapshot | null | undefined,
	options: { readonly noLive: boolean; readonly lineId: string; readonly copy?: VerdictCopy },
): DirectoryEvidence {
	if (snapshot?.failed === true) return { ...EMPTY_EVIDENCE, state: 'failed' };
	if (!snapshot || snapshot.phase === 'idle' || snapshot.phase === 'loading') return EMPTY_EVIDENCE;
	if (options.noLive) return { ...EMPTY_EVIDENCE, state: 'no-live' };
	// A cached file belongs to the id it was read for; never answer a row from another line's file.
	if (!snapshot.routeData || snapshot.routeData.id !== options.lineId)
		return { ...EMPTY_EVIDENCE, state: 'not-published' };
	const { record, verdict, publication } = selectDirectoryRecord(snapshot.routeData, options.copy);
	const base = {
		...EMPTY_EVIDENCE,
		...periodFields(record.period),
		source: 'current_route_record' as const,
		publication,
		hedge: verdict.hedge,
		verdictStatus: verdict.status,
	};
	const readings = verdict.observationCount;
	if (
		readings != null &&
		Number.isSafeInteger(readings) &&
		readings >= 0 &&
		readings < VERDICT_MIN_N
	)
		return { ...base, state: 'low-sample', readings, classification: 'too-few' };
	if (record.answer.kind !== 'figure') return { ...base, state: 'not-published' };
	const answer = record.answer;
	if (answer.classification === 'too-few')
		return {
			...base,
			state: 'low-sample',
			readings: answer.readings,
			classification: answer.classification,
		};
	return {
		...base,
		state: answer.classification === 'uncertain' ? 'uncertain' : 'figure',
		percent: answer.percent,
		readings: answer.readings,
		classification: answer.classification,
	};
}

/**
 * A compared row's evidence from the published index entry itself: its own week, its own counts
 * and the index's publication identity. Nothing is borrowed from another week's route file.
 */
export function comparisonEvidence(
	entry: WeeklyEntry,
	comparison: DirectoryComparison,
): DirectoryEvidence {
	const older = entry.window_end < comparison.period.to;
	const window = {
		from: entry.window_start,
		to: entry.window_end,
		days: comparison.period.days,
	};
	if (entry.state !== 'ranked')
		return {
			...EMPTY_EVIDENCE,
			state: 'unranked',
			source: 'published_weekly_index',
			...window,
			publication: comparison.publication,
			excluded: entry.state,
			older,
		};
	return {
		...EMPTY_EVIDENCE,
		state: 'figure',
		source: 'published_weekly_index',
		...window,
		percent: entry.pct,
		readings: entry.denominator,
		publication: comparison.publication,
		older,
	};
}

export type SupportedDirectoryFigure = DirectoryEvidence & {
	readonly state: 'figure' | 'uncertain';
	readonly percent: number;
	readonly from: string;
	readonly to: string;
	readonly days: number;
};

/** The definition shared by citation and selected-record export; a known zero share is valid. */
export function hasDirectoryFigure(
	evidence: DirectoryEvidence,
): evidence is SupportedDirectoryFigure {
	const { percent, readings, from, to, days } = evidence;
	if (
		(evidence.state !== 'figure' && evidence.state !== 'uncertain') ||
		percent == null ||
		!Number.isInteger(percent) ||
		percent < 0 ||
		percent > 100 ||
		(readings != null && (!Number.isSafeInteger(readings) || readings < VERDICT_MIN_N)) ||
		from == null ||
		to == null ||
		days == null ||
		!Number.isSafeInteger(days) ||
		days <= 0
	)
		return false;
	const validKey = (key: string) => {
		if (!/^\d{4}-\d{2}-\d{2}$/u.test(key) || key.startsWith('0000')) return false;
		const instant = Date.parse(`${key}T00:00:00Z`);
		return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === key;
	};
	return (
		validKey(from) &&
		validKey(to) &&
		(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1 === days
	);
}

/** One row of the list: the published line, plus a comparison entry when the week supplies one. */
export interface DirectoryRow {
	readonly line: RouteIndexEntry;
	readonly entry: WeeklyEntry | null;
	readonly ranked: boolean;
}

/**
 * Comparison order: the publisher's ranked rows first, in the order it supplied (never re-sorted),
 * then every remaining current line below in line-number order with its own reason for sitting
 * there. Rows the index does not mention at all stay, without an invented reason.
 */
export function comparisonRows(
	matches: readonly RouteIndexEntry[],
	comparison: DirectoryComparison,
): DirectoryRow[] {
	const byId = new Map(matches.map((line) => [line.id, line]));
	const ranked: DirectoryRow[] = [];
	const seen = new Set<string>();
	for (const entry of comparison.ranked) {
		const line = byId.get(entry.id);
		if (!line) continue;
		seen.add(entry.id);
		ranked.push({ line, entry, ranked: true });
	}
	const excluded = new Map<string, WeeklyEntry>();
	for (const entry of comparison.entries)
		if (entry.state !== 'ranked' && !seen.has(entry.id)) excluded.set(entry.id, entry);
	const rest: DirectoryRow[] = [];
	for (const line of matches) {
		if (seen.has(line.id)) continue;
		rest.push({ line, entry: excluded.get(line.id) ?? null, ranked: false });
	}
	return [...ranked, ...rest];
}

export type ProblemAssessment = 'problem' | 'pending' | 'failed' | 'clean';

/**
 * Whether a row belongs in the problem list: only the existing patchy/unreliable verdict does,
 * a read still pending stays visible while it settles, a failed read stays visible and retryable,
 * and everything else (reliable, tentative, absent, unpublished) is not a problem.
 */
export function problemAssessment(evidence: DirectoryEvidence): ProblemAssessment {
	if (evidence.state === 'loading') return 'pending';
	if (evidence.state === 'failed') return 'failed';
	return evidence.verdictStatus != null && isProblemVerdict(evidence.verdictStatus)
		? 'problem'
		: 'clean';
}
