import { intl, type Locale } from '#lib/i18n/copy.ts';
import type { CutScope } from './selectors/evidence';

function parseKey(key: string): Date | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
	const date = new Date(`${key}T00:00:00Z`);
	return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== key ? null : date;
}

type Part = 'day' | 'month' | 'year' | 'weekday';

function parts(date: Date, locale: Locale): Record<Part, string> {
	const out = { day: '', month: '', year: '', weekday: '' };
	for (const part of intl
		.dateTime(locale, {
			weekday: 'long',
			day: 'numeric',
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC',
		})
		.formatToParts(date))
		if (part.type in out) out[part.type as Part] = part.value;
	return out;
}

/**
 * Complete days in words, as a record names them: "November 4 to 10" / "du 4 au 10 novembre",
 * one day with its weekday. `year` adds the year, for a citation. Null for a malformed key.
 */
export function formatRecordDates(
	from: string,
	to: string,
	locale: Locale,
	{ year = false }: { year?: boolean } = {},
): string | null {
	const start = parseKey(from);
	const end = parseKey(to);
	if (!start || !end) return null;
	const a = parts(start, locale);
	const b = parts(end, locale);
	const fr = locale === 'fr';
	if (from === to)
		return fr
			? `${a.weekday} ${a.day} ${a.month}${year ? ` ${a.year}` : ''}`
			: `${a.weekday}, ${a.month} ${a.day}${year ? `, ${a.year}` : ''}`;
	const sameYear = a.year === b.year;
	const sameMonth = sameYear && a.month === b.month;
	if (fr) {
		const startText = sameMonth ? a.day : `${a.day} ${a.month}${sameYear ? '' : ` ${a.year}`}`;
		return `du ${startText} au ${b.day} ${b.month}${year || !sameYear ? ` ${b.year}` : ''}`;
	}
	const startText = `${a.month} ${a.day}${sameYear ? '' : `, ${a.year}`}`;
	const endText = sameMonth ? b.day : `${b.month} ${b.day}`;
	return `${startText} to ${endText}${year || !sameYear ? `, ${b.year}` : ''}`;
}

/** The days one published cut covers, in words, or `history` for an all-history cut; null when unnamed. */
export function scopeDates(scope: CutScope, locale: Locale, history: string): string | null {
	if (scope.kind === 'window') return formatRecordDates(scope.from, scope.to, locale);
	return scope.kind === 'history' ? history : null;
}
