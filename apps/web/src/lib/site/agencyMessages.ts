import type { Locale } from '#lib/i18n/index.ts';
import {
	alertDisplayUrl,
	isGenericAlertHeading,
	safeAlertUrl,
	stripAlertHtml,
} from '#lib/v1/alertDisplay.ts';
import { providerLocalDateKey } from '#lib/utils/time.ts';
import { clockTime, dateRange, noticeStopName } from './presenter.ts';
import { presenterCopy } from './presenter.copy.ts';

type AgencyTranslation = Partial<Record<Locale, string | null>>;
type AgencyReading = { text: string; lang: Locale };

export type AgencyMessage = {
	routes: readonly string[];
	header: AgencyTranslation;
	description: AgencyTranslation;
	url?: AgencyTranslation;
	periods?: readonly AgencyMessagePeriod[];
};

function translation(text: AgencyTranslation, locale: Locale) {
	const other: Locale = locale === 'en' ? 'fr' : 'en';
	const preferred = text[locale];
	const fallback = text[other];
	if (preferred?.trim()) return { text: preferred, lang: locale };
	if (fallback?.trim()) return { text: fallback, lang: other };
	return null;
}

function agencyText(translations: AgencyTranslation, locale: Locale) {
	const selected = translation(translations, locale);
	if (!selected) return null;
	if (!/<\/?[a-z][^>]*>|&(?:nbsp|amp|quot|#39|lt|gt);/i.test(selected.text)) return selected;
	const text = selected.text
		.replace(/<(?:br\b[^>]*|\/(?:p|div|li|h[1-6])\s*)>/gi, '\n')
		.split(/\r?\n/)
		.map(stripAlertHtml)
		.filter(Boolean)
		.join('\n');
	return text ? { text, lang: selected.lang } : null;
}

const sentenceSegments = {
	en: new Intl.Segmenter('en', { granularity: 'sentence' }),
	fr: new Intl.Segmenter('fr', { granularity: 'sentence' }),
};

export function agencyMessagePreview({ text, lang }: AgencyReading) {
	const line = text.trim().split(/\r?\n/, 1)[0];
	return (
		sentenceSegments[lang].segment(line)[Symbol.iterator]().next().value?.segment.trim() ?? line
	);
}

export function agencyMessage(
	card: AgencyMessage,
	locale: Locale,
	stops: readonly string[] = [],
	stopName: (id: string) => string = (id) => id,
) {
	const reading = readAgencyMessage(card, locale);
	if (stops.length !== 1) return reading;
	const name = stopName(stops[0]);
	const title = {
		...reading.title,
		text: noticeStopName(reading.title.text, name, reading.title.lang),
	};
	const body = reading.body && {
		...reading.body,
		text: noticeStopName(reading.body.text, name, reading.body.lang),
	};
	return { title, body };
}

function readAgencyMessage(card: AgencyMessage, locale: Locale) {
	const heading = agencyText(card.header, locale);
	const other = locale === 'en' ? 'fr' : 'en';
	const alternate = agencyText({ [other]: card.header[other] }, other);
	const title = [heading, alternate].find(
		(reading) => reading && !isGenericAlertHeading(reading.text),
	);
	const emptyTitle = {
		text: locale === 'fr' ? 'Avis sans texte' : 'Message without text',
		lang: locale,
	};
	const description = agencyText(card.description, locale);
	if (!description) return { title: title ?? emptyTitle, body: null };

	const lines = description.text.trim().split(/\r?\n/);
	while (lines.length && (!lines[0].trim() || isGenericAlertHeading(lines[0]))) lines.shift();
	const text = lines.join('\n').trim();
	if (!text) return { title: title ?? emptyTitle, body: null };
	const first = agencyMessagePreview({ text, lang: description.lang });
	const sameHeading =
		title?.lang === description.lang &&
		title.text.trim().replace(/[.!?]$/, '') === first.replace(/[.!?]$/, '');
	const body = title && !sameHeading ? text : text.slice(first.length).trimStart();
	return {
		title: title ?? { text: first, lang: description.lang },
		body: body ? { text: body, lang: description.lang } : null,
	};
}

export function agencyMessageLink(card: AgencyMessage, locale: Locale) {
	const link = translation(card.url ?? {}, locale);
	const url = safeAlertUrl(link?.text);
	if (url && link) return { href: url.href, lang: link.lang };
	const body = translation(card.description, locale);
	const embedded = alertDisplayUrl({ description: body?.text }, locale);
	return embedded && body ? { href: embedded.href, lang: body.lang } : null;
}

export function sortAgencyMessages<Message extends AgencyMessage>(
	cards: readonly Message[],
	locale: Locale,
	lineLabel: (id: string) => string,
) {
	const collator = new Intl.Collator(locale, { numeric: true });
	return cards
		.map((card) => ({
			card,
			start: firstStart(card),
			line: card.routes[0] ? lineLabel(card.routes[0]) : null,
			message: agencyMessage(card, locale),
		}))
		.sort(
			(a, b) =>
				b.start - a.start ||
				Number(a.line === null) - Number(b.line === null) ||
				collator.compare(a.line ?? '', b.line ?? '') ||
				collator.compare(a.message.title.text, b.message.title.text) ||
				collator.compare(a.message.body?.text ?? '', b.message.body?.text ?? ''),
		)
		.map(({ card }) => card);
}

function firstStart(card: AgencyMessage) {
	const start = (card.periods ?? []).reduce(
		(earliest, period) => (period.start ? Math.min(earliest, Date.parse(period.start)) : earliest),
		Infinity,
	);
	return start === Infinity ? -Infinity : start;
}

export type AgencyMessagePeriod = { start: string | null; end: string | null };

function dayFirstDateAndClock(iso: string, locale: Locale, timeZone: string) {
	const day = providerLocalDateKey(iso, timeZone);
	if (!day) return presenterCopy[locale].unknownTime;
	return `${dateRange({ from: day, to: day }, locale)}, ${clockTime(new Date(iso), locale, timeZone)}`;
}

export function agencyMessagePeriods(
	periods: readonly AgencyMessagePeriod[] | undefined,
	locale: Locale,
	timeZone = 'UTC',
	live: boolean,
) {
	if (!periods?.length) return [];
	if (live) {
		return [
			...new Set(
				periods.flatMap(({ start, end }) => {
					const since = start && dayFirstDateAndClock(start, locale, timeZone);
					const until = end && dayFirstDateAndClock(end, locale, timeZone);
					return [
						since && (locale === 'fr' ? `Depuis le ${since}.` : `Since ${since}.`),
						until && (locale === 'fr' ? `Jusqu’au ${until}.` : `Until ${until}.`),
					].filter((reading): reading is string => Boolean(reading));
				}),
			),
		];
	}
	const ranges = periods
		.flatMap(({ start, end }) => {
			if (!start || !end) return [];
			const span = { start: Date.parse(start), end: Date.parse(end) };
			return Number.isFinite(span.start) && Number.isFinite(span.end) && span.end >= span.start
				? [span]
				: [];
		})
		.sort((a, b) => a.start - b.start);
	const union: typeof ranges = [];
	for (const span of ranges) {
		const last = union.at(-1);
		if (last && span.start - last.end < 10 * 60_000) last.end = Math.max(last.end, span.end);
		else union.push(span);
	}
	return union.flatMap(({ start, end }) => {
		const from = providerLocalDateKey(new Date(start).toISOString(), timeZone);
		const to = providerLocalDateKey(new Date(Math.max(start, end - 1)).toISOString(), timeZone);
		if (!from || !to) return [];
		const days = dateRange({ from, to }, locale);
		if (from !== to || providerLocalDateKey(new Date(end).toISOString(), timeZone) !== from)
			return [days];
		const first = clockTime(new Date(start), locale, timeZone);
		const last = clockTime(new Date(end), locale, timeZone);
		return [locale === 'fr' ? `${days}, de ${first} à ${last}` : `${days}, ${first} to ${last}`];
	});
}
