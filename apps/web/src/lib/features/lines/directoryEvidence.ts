import type { RouteReliability } from '#lib/v1/index.ts';
import {
	RouteReliabilityIndexSchema,
	type RouteReliabilityIndex,
} from '#lib/v1/schemas/route_reliability_index.ts';
import { createPublishedWeeklyRanking } from '#lib/v1/ranking/published.ts';
import { reliabilityVerdict, type ReliabilityVerdict, type VerdictCopy } from '#lib/v1/verdict.ts';
import {
	selectLineRecord,
	sharedPublication,
	type LineRecord,
	type RecordPeriod,
	type RecordPublication,
} from './reliability/selectors/lineRecord';

type WeeklyEntry = NonNullable<RouteReliabilityIndex['weekly_routes']>[number];
type RankedEntry = Extract<WeeklyEntry, { state: 'ranked' }>;

export interface DirectoryComparison {
	readonly entries: readonly WeeklyEntry[];
	readonly ranked: readonly RankedEntry[];
	readonly period: RecordPeriod;
	readonly publication: RecordPublication;
}

/**
 * Admit the publisher's comparison only when its dates and mathematical order agree.
 * The existing reader owns schema validation and publication freshness. This module
 * neither calculates a new percentage nor repairs an incoherent published ranking.
 */
export function createDirectoryComparison(
	value: unknown,
	timeZone = 'UTC',
): (now: number) => DirectoryComparison | null {
	let parsed: ReturnType<typeof RouteReliabilityIndexSchema.safeParse>;
	try {
		parsed = RouteReliabilityIndexSchema.safeParse(value);
	} catch (error) {
		// Its numeric refinement may throw for an already-invalid zero denominator.
		// Refuse that comparison; unexpected programming errors still propagate.
		if (!(error instanceof RangeError)) throw error;
		return () => null;
	}
	if (!parsed.success) return () => null;
	const index = parsed.data;
	const read = createPublishedWeeklyRanking(index);
	const entries = (index.weekly_routes ?? []).map((row) =>
		row.state === 'ranked' && Object.is(row.pct, -0) ? { ...row, pct: 0 } : row,
	);
	const ranked = entries.filter((row): row is RankedEntry => row.state === 'ranked');
	const first = ranked[0];
	if (!first) return () => null;
	let calendar: Intl.DateTimeFormat;
	try {
		calendar = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			calendar: 'gregory',
			numberingSystem: 'latn',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		});
	} catch (error) {
		if (!(error instanceof RangeError)) throw error;
		return () => null;
	}
	const dateKey = (instant: number) => {
		const parts = calendar.formatToParts(instant);
		const part = (type: string) => parts.find((value) => value.type === type)?.value ?? '';
		return `${part('year')}-${part('month')}-${part('day')}`;
	};
	// A legacy midnight stamp names the publication's calendar date, not its actual instant.
	const publicationDay = index.published_utc
		? dateKey(Date.parse(index.published_utc))
		: index.generated_utc.slice(0, 10);
	if (entries.some((row) => row.window_end >= publicationDay)) return () => null;
	for (const [position, row] of ranked.entries()) {
		if (row.window_start !== first.window_start || row.window_end !== first.window_end)
			return () => null;
		const prior = ranked[position - 1];
		if (
			prior &&
			(prior.rank > row.rank ||
				BigInt(prior.numerator) * BigInt(row.denominator) >
					BigInt(row.numerator) * BigInt(prior.denominator))
		)
			return () => null;
	}
	const comparison: DirectoryComparison = {
		entries,
		ranked,
		period: { from: first.window_start, to: first.window_end, days: 7 },
		publication: sharedPublication([index]),
	};
	return (now) => {
		if (!read('route', now)) return null;
		const today = dateKey(now);
		return entries.every((row) => row.window_end < today) ? comparison : null;
	};
}

export interface DirectoryRecord {
	readonly record: LineRecord;
	readonly verdict: ReliabilityVerdict;
	readonly publication: RecordPublication;
}

/** The same latest complete-week answer and source identity used by the line's Record view. */
export function selectDirectoryRecord(data: RouteReliability, copy?: VerdictCopy): DirectoryRecord {
	const verdict = reliabilityVerdict(data, { kind: 'route', grain: 'week' }, copy);
	return {
		record: selectLineRecord({ data, verdict, mode: 'week' }),
		verdict,
		publication: sharedPublication([data]),
	};
}
