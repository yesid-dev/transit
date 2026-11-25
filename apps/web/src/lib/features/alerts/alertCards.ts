import type { Locale } from '#lib/i18n/index.ts';
import type { RecordMeasure, RecordSeries } from '#lib/server/engine.ts';
import { alertDisplayUrl, safeAlertUrl, stripAlertHtml } from '#lib/v1/alertDisplay.ts';
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
	const other = locale === 'en' ? 'fr' : 'en';
	const preferred = text[locale];
	const fallback = text[other];
	if (preferred?.trim()) return { text: preferred, lang: locale };
	if (fallback?.trim()) return { text: fallback, lang: other };
	return null;
}

export function agencyText(translations: Translation, locale: Locale) {
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

export function alertEffect(effect: string | null, locale: Locale) {
	return effectLabel(effect, locale) ?? (locale === 'fr' ? 'Inconnu' : 'Unknown');
}

export function alertAgencyLink(card: AlertCard, locale: Locale) {
	const link = translation(card.url ?? {}, locale);
	const url = safeAlertUrl(link?.text);
	if (url && link) return { href: url.href, lang: link.lang };
	const body = translation(card.description, locale);
	const embedded = alertDisplayUrl({ description: body?.text }, locale);
	return embedded && body ? { href: embedded.href, lang: body.lang } : null;
}

export function genericAgencyHeading(text: string | null | undefined) {
	return /^(your (line|stop)|votre (ligne|arr[êe]t))[.:]?$/i.test(text?.trim() ?? '');
}

function newestFirst(cards: AlertCard[]) {
	return cards.sort(
		(a, b) =>
			firstStart(b) - firstStart(a) || a.key.localeCompare(b.key, undefined, { numeric: true }),
	);
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
	return newestFirst(
		(messages ?? []).map((message) => ({
			...message,
			key: JSON.stringify([message.source, message.id, message.version]),
			effect: null,
			periods: message.periods ?? [],
		})),
	);
}

export function liveAlertCards(alerts: readonly Alert[], now: number): AlertCard[] {
	return newestFirst(
		alerts.flatMap((alert) => {
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
					effect: alert.effect?.trim().toUpperCase() || null,
					periods,
				},
			];
		}),
	);
}

export type AlertCut = { key: string; value: number | null; state?: string };

export function liveAlertCut(cards: readonly AlertCard[], group: 'effect' | 'line'): AlertCut[] {
	const counts = new Map<string, number>();
	for (const card of cards) {
		const keys = group === 'line' ? new Set(card.routes) : [card.effect ?? 'UNKNOWN_EFFECT'];
		for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return Array.from(counts, ([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
}

export function recordAlertCut(answer: RecordSeries, group: 'effect' | 'line'): AlertCut[] {
	return answer.cells.map((cell) => ({
		key: String(cell.key[group] ?? (group === 'effect' ? 'UNKNOWN_EFFECT' : '')),
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
