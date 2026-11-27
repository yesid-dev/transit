import type { Locale } from '#lib/i18n/index.ts';
import {
	citationAccessed,
	citationSourceSentence,
	citeDates,
	type CitationSource,
} from '#lib/site/presenter.ts';

/**
 * The citation of one Daily report section, in the order of every page citation: who published
 * it, what, which dates, the reading and its method, the source and licence of the data, the day
 * it was accessed, then the link that keeps those dates.
 */
export function dailySectionCitation(
	parts: {
		subject: string;
		section: string;
		period: { from: string; to: string };
		statement?: string;
		method: string;
		note?: string;
		source: CitationSource;
		href: string;
		/** A date key; today (UTC) by default. */
		accessed?: string;
	},
	locale: Locale,
): string {
	return [
		`Transit · ${parts.subject}. ${parts.section}. ${citeDates(parts.period, locale)}.`,
		parts.statement,
		parts.method,
		parts.note,
		citationSourceSentence(parts.source, locale),
		citationAccessed(parts.accessed ?? new Date().toISOString().slice(0, 10), locale),
		parts.href,
	]
		.filter(Boolean)
		.join(' ');
}
