import type { Locale } from '#lib/i18n/index.ts';
import type { RecordMeasure, RecordSeries } from '#lib/server/engine.ts';
import {
	alertDisplayUrl,
	isGenericAlertHeading,
	safeAlertUrl,
	stripAlertHtml,
} from '#lib/v1/alertDisplay.ts';
import { effectLabel } from '#lib/v1/gtfsAlertLabels.ts';
import type { Alert } from '#lib/v1/schemas/alerts.ts';

type Translation = Partial<Record<Locale, string | null>>;
export type AlertCard = {
	key: string;
	id: string;
	routes: readonly string[];
	stops: readonly string[];
	header: Translation;
	description: Translation;
	url?: Translation;
	effect: string | null;
	periods: readonly { start: string | null; end: string | null }[];
};

function translation(text: Translation, locale: Locale) {
	const other: Locale = locale === 'en' ? 'fr' : 'en';
	const preferred = text[locale];
	const fallback = text[other];
	if (preferred?.trim()) return { text: preferred, lang: locale };
	if (fallback?.trim()) return { text: fallback, lang: other };
	return null;
}

function agencyText(translations: Translation, locale: Locale) {
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

export function agencyMessage(card: AlertCard, locale: Locale) {
	const heading = agencyText(card.header, locale);
	const other = locale === 'en' ? 'fr' : 'en';
	const alternate = agencyText({ [other]: card.header[other] }, other);
	const title = [heading, alternate].find(
		(reading) => reading && !isGenericAlertHeading(reading.text),
	);
	const description = agencyText(card.description, locale);
	if (!description) return { title, body: null };

	const lines = description.text.trim().split(/\r?\n/);
	while (lines.length && (!lines[0].trim() || isGenericAlertHeading(lines[0]))) lines.shift();
	const text = lines.join('\n').trim();
	if (!text) return { title, body: null };
	const first =
		sentenceSegments[description.lang]
			.segment(lines[0])
			[Symbol.iterator]()
			.next()
			.value?.segment.trim() ?? lines[0].trim();
	const sameHeading =
		title?.lang === description.lang &&
		title.text.trim().replace(/[.!?]$/, '') === first.replace(/[.!?]$/, '');
	const body = title && !sameHeading ? text : text.slice(first.length).trimStart();
	return {
		title: title ?? { text: first, lang: description.lang },
		body: body ? { text: body, lang: description.lang } : null,
	};
}

export const unstatedEffect = 'UNKNOWN_EFFECT';

export function publishedAlertEffect(effect: string | null | undefined) {
	const key = effect?.trim().toUpperCase();
	return key && effectLabel(key, 'en') ? key : null;
}

export function alertEffect(effect: string | null, locale: Locale) {
	return effectLabel(effect, locale) ?? (locale === 'fr' ? 'Non précisé' : 'Not stated');
}

export function alertAgencyLink(card: AlertCard, locale: Locale) {
	const link = translation(card.url ?? {}, locale);
	const url = safeAlertUrl(link?.text);
	if (url && link) return { href: url.href, lang: link.lang };
	const body = translation(card.description, locale);
	const embedded = alertDisplayUrl({ description: body?.text }, locale);
	return embedded && body ? { href: embedded.href, lang: body.lang } : null;
}

export function sortAlertCards(
	cards: readonly AlertCard[],
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
				collator.compare(a.message.title?.text ?? '', b.message.title?.text ?? '') ||
				collator.compare(a.message.body?.text ?? '', b.message.body?.text ?? ''),
		)
		.map(({ card }) => card);
}

function firstStart(card: AlertCard) {
	const start = card.periods.reduce(
		(earliest, period) => (period.start ? Math.min(earliest, Date.parse(period.start)) : earliest),
		Infinity,
	);
	return start === Infinity ? -Infinity : start;
}

export function recordAlertCards(
	messages: RecordMeasure['evidence']['alert_messages'],
): AlertCard[] {
	return (messages ?? []).map((message) => ({
		...message,
		key: JSON.stringify([message.source, message.id, message.version]),
		effect: publishedAlertEffect(message.effect),
		periods: message.periods ?? [],
	}));
}

export function liveAlertCards(alerts: readonly Alert[], now: number): AlertCard[] {
	return alerts.flatMap((alert) => {
		const published = alert.active_periods?.length
			? alert.active_periods
			: [{ start_utc: alert.start_utc, end_utc: alert.end_utc }];
		const periods = published
			.filter(
				({ start_utc, end_utc }) =>
					(!start_utc || Date.parse(start_utc) <= now) && (!end_utc || Date.parse(end_utc) > now),
			)
			.map(({ start_utc, end_utc }) => ({ start: start_utc ?? null, end: end_utc ?? null }));
		if (!periods.length) return [];
		return [
			{
				id: alert.id,
				key: alert.id,
				routes: alert.routes ?? [],
				stops: alert.stops ?? [],
				header: { en: alert.header_text_en, fr: alert.header_text },
				description: { en: alert.description_en, fr: alert.description },
				url: { en: alert.url_en, fr: alert.url },
				effect: publishedAlertEffect(alert.effect),
				periods,
			},
		];
	});
}

export type AlertCut = { key: string; value: number | null; state?: string };

export function sortAlertLineCut(
	rows: readonly AlertCut[],
	locale: Locale,
	lineNumber: (id: string) => string,
): AlertCut[] {
	const order = new Intl.Collator(locale, { numeric: true });
	return rows.toSorted(
		(a, b) =>
			(b.value ?? -Infinity) - (a.value ?? -Infinity) ||
			Number(!a.key) - Number(!b.key) ||
			order.compare(lineNumber(a.key), lineNumber(b.key)),
	);
}

export function liveAlertCut(cards: readonly AlertCard[], group: 'effect' | 'line'): AlertCut[] {
	const counts = new Map<string, number>();
	for (const card of cards) {
		const keys = group === 'line' ? new Set(card.routes) : [card.effect ?? unstatedEffect];
		for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return Array.from(counts, ([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
}

export function recordAlertCut(answer: RecordSeries, group: 'effect' | 'line'): AlertCut[] {
	return answer.cells.map((cell) => ({
		key:
			group === 'effect'
				? (publishedAlertEffect(typeof cell.key.effect === 'string' ? cell.key.effect : null) ??
					unstatedEffect)
				: String(cell.key.line ?? ''),
		value: cell.state === 'measured' ? (cell.value.alerts ?? null) : null,
		state: cell.state === 'measured' ? undefined : cell.state,
	}));
}

export function alertTarget(url: URL) {
	const hash = url.hash.slice(1);
	return (
		url.searchParams.get('alert') ?? (hash.startsWith('alert-') ? safeDecode(hash.slice(6)) : null)
	);
}

function safeDecode(value: string) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
