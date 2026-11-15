import { intl, type Locale } from '#lib/i18n/copy.ts';
import { formatRelativeSeconds } from '#lib/utils/time.ts';
import type { DataHealthGate } from '#lib/v1/schemas/index.ts';
import { liveStamp, stampDate, stampText, type RecordStamp } from '#lib/v1/stamp.ts';
import { copy } from '../health.copy';

export interface HealthSummaryFacts {
	/** The live vehicles feed once it has answered; null while nothing is known yet. */
	readonly live: {
		readonly ageSeconds: number | null;
		readonly isStale: boolean;
		/** The store's notice: "refresh-unavailable" after a failed request or during a retry. */
		readonly notice?: string | null;
	} | null;
	readonly record: RecordStamp;
	/**
	 * The record's last quality check (data health's rollup lane). Undefined while data health has
	 * not answered; null when it answered without a record check.
	 */
	readonly gate?: DataHealthGate | null;
	readonly gaps: readonly string[];
}

/**
 * The three plain answers that open data health, one per column: how current live data is, what
 * the record covers and how its publication check went, and what is known to limit the figures.
 */
export function healthSummary(facts: HealthSummaryFacts, locale: Locale, timeZone?: string) {
	const t = copy[locale].summary;
	const { live, record, gate, gaps } = facts;
	const date = (key: string | null) => (key ? stampDate(key.slice(0, 10), locale, timeZone) : null);
	const [through, published, next] = [record.dataThrough, record.publishedOn, record.nextUpdateUtc];
	const covered =
		through && published
			? t.record(date(through)!, date(published)!)
			: stampText(record, locale, timeZone);
	// After a failed request the shown age says nothing about newer data: treat it as unknown.
	const age = live?.notice === 'refresh-unavailable' ? null : (live?.ageSeconds ?? null);
	const warnings = gate?.verdict === 'warn' ? (gate.warnings ?? 0) : 0;
	// Reassure only on a passed check and current live data; an unknown is never "nothing known".
	const reassured = gate?.verdict === 'pass' && age != null && !live!.isStale;
	const names = gaps.map((gap) => copy[locale].gaps.names[gap] ?? gap.replace(/_/g, ' '));
	// A failed verdict only reaches data health when the record was forced out past its check.
	const check =
		gate === undefined
			? null
			: gate === null
				? t.noCheck
				: gate.verdict === 'pass'
					? t.passed
					: gate.verdict === 'fail'
						? t.failed
						: warnings > 0
							? t.warning(intl.number(locale).format(warnings), warnings)
							: null;
	const limits = [reassured && t.clear, names.length > 0 && t.gaps(names.join(', '))].filter(
		Boolean,
	);
	return {
		/** The live mark's state, matching the live sentence; null before live data answers. */
		liveState: !live ? null : age == null ? 'unknown' : live.isStale ? 'behind' : 'current',
		live: !live
			? null
			: age == null
				? stampText(liveStamp({ ageSeconds: null }), locale, timeZone)
				: (live.isStale ? t.behind : t.current)(formatRelativeSeconds(age, locale)),
		record: covered ? [covered, next && t.next(date(next)!)].filter(Boolean).join(' ') : t.noRecord,
		check,
		limits: limits.length > 0 ? limits.join(' ') : t.unconfirmed,
	};
}
