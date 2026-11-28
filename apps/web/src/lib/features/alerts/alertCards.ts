import type { Locale } from '#lib/i18n/index.ts';
import type { RecordMeasure, RecordSeries } from '#lib/server/engine.ts';
import {
	agencyMessage,
	type AgencyMessage,
	type AgencyMessagePeriod,
} from '#lib/site/agencyMessages.ts';
import { effectLabel } from '#lib/v1/gtfsAlertLabels.ts';
import type { CaptureSnapshot } from '#lib/live/captureSnapshot.ts';
import type { Alert } from '#lib/v1/schemas/generated/live_alerts.ts';
import { isGenericAlertHeading } from '#lib/v1/alertDisplay.ts';

export type AlertCard = AgencyMessage & {
	key: string;
	id: string;
	reissue_ids?: readonly string[];
	stops: readonly string[];
	effect: string | null;
	periods: readonly AgencyMessagePeriod[];
	publishedPeriods?: readonly AgencyMessagePeriod[];
};

export type NoticeCard = AlertCard & { ids: string[] };

function normalizedNoticeText(text: string) {
	return text
		.normalize('NFC')
		.replace(/['’]/gu, '’')
		.replace(/\s+/gu, ' ')
		.trim()
		.replace(/[.]$/u, '');
}

function periodInstant(value: string | null) {
	if (value === null) return null;
	const instant = Date.parse(value);
	return Number.isFinite(instant) ? instant : value;
}

/** Match the readable text in both languages and the same set of active intervals. */
export function groupAlertCards(
	cards: readonly AlertCard[],
	include: (card: AlertCard) => boolean = () => true,
): NoticeCard[] {
	const groups = new Map<string, NoticeCard>();
	const included = new Set<string>();
	for (const card of cards) {
		const text = (['en', 'fr'] as const).map((locale) => {
			const { title, body } = agencyMessage(card, locale);
			return [title, body].map((part) => part && [part.lang, normalizedNoticeText(part.text)]);
		});
		const intervals = [
			...new Set(
				(card.publishedPeriods ?? card.periods).map(({ start, end }) =>
					JSON.stringify([periodInstant(start), periodInstant(end)]),
				),
			),
		].sort();
		// Missing wording provides no evidence that two independent notices are the same.
		const hasText = [...Object.values(card.header), ...Object.values(card.description)].some(
			(value) => value?.trim() && !isGenericAlertHeading(value),
		);
		const key = JSON.stringify(hasText ? [text, intervals] : [card.key]);
		if (include(card)) included.add(key);
		const group = groups.get(key);
		const ids = [card.id, ...(card.reissue_ids ?? [])];
		if (group) {
			group.ids = [...new Set([...group.ids, ...ids])];
			group.routes = [...new Set([...group.routes, ...card.routes])];
			group.stops = [...new Set([...group.stops, ...card.stops])];
			if (group.effect !== card.effect) group.effect = null;
			group.url = { ...card.url, ...group.url };
		} else {
			groups.set(key, {
				...card,
				ids,
				routes: [...new Set(card.routes)],
				stops: [...new Set(card.stops)],
			});
		}
	}
	return [...included].map((key) => groups.get(key)!);
}

export const unstatedEffect = 'UNKNOWN_EFFECT';

export function publishedAlertEffect(effect: string | null | undefined) {
	const key = effect?.trim().toUpperCase();
	return key && effectLabel(key, 'en') ? key : null;
}

export function alertEffect(effect: string | null, locale: Locale) {
	return effectLabel(effect, locale) ?? (locale === 'fr' ? 'Non précisé' : 'Not stated');
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

/**
 * The engine's count of distinct notices: one wording over the same periods, however many
 * lines or stops the agency repeated it for. Every screen reads this one number. An engine
 * from before it gives only its count of alert IDs.
 */
export function noticeTotal(value: Readonly<Record<string, number | null>>) {
	return value.notices ?? value.alerts ?? null;
}

export function recordNoticeCards(answer: RecordMeasure) {
	const messages = answer.evidence.alert_messages;
	if (messages?.length) return groupAlertCards(recordAlertCards(messages));
	return noticeTotal(answer.value) === 0 ? [] : null;
}

type LiveAlert = NonNullable<CaptureSnapshot['alerts']>[number];

/**
 * The notices in effect at `now`, each counted once: a bilingual reissue or a later version is
 * the same notice. Service alerts shows this number live, and the Overview's Live now card too.
 */
export function liveNoticeCount(alerts: readonly LiveAlert[], now: number) {
	return groupAlertCards(liveAlertCards(alerts, now)).length;
}

/** A published alert file's entry in the shape of a live capture's alert. */
export function captureAlertOf(alert: Alert): LiveAlert {
	const texts = (fr: string | null | undefined, en: string | null | undefined) =>
		Object.fromEntries(
			Object.entries({ fr, en }).filter((entry): entry is [string, string] => !!entry[1]),
		);
	return {
		id: alert.id,
		header: texts(alert.header_text, alert.header_text_en),
		description: texts(alert.description, alert.description_en),
		url: texts(alert.url, alert.url_en),
		cause: alert.cause ?? null,
		effect: alert.effect ?? null,
		severity: alert.severity_level ?? null,
		routes: alert.routes ?? [],
		stops: alert.stops ?? [],
		periods: (alert.active_periods?.length
			? alert.active_periods
			: [{ start_utc: alert.start_utc, end_utc: alert.end_utc }]
		).map(
			({ start_utc, end_utc }) =>
				[start_utc ?? null, end_utc ?? null] as [string | null, string | null],
		),
	};
}

export function liveAlertCards(
	alerts: Readonly<NonNullable<CaptureSnapshot['alerts']>>,
	now: number,
): AlertCard[] {
	return alerts.flatMap((alert) => {
		const published = alert.periods.length ? alert.periods : [[null, null] as const];
		const periods = published
			.filter(
				([start, end]) => (!start || Date.parse(start) <= now) && (!end || Date.parse(end) > now),
			)
			.map(([start, end]) => ({ start, end }));
		if (!periods.length) return [];
		return [
			{
				id: alert.id,
				key: alert.id,
				routes: alert.routes,
				stops: alert.stops,
				header: alert.header,
				description: alert.description,
				url: alert.url,
				effect: publishedAlertEffect(alert.effect),
				periods,
				publishedPeriods: published.map(([start, end]) => ({ start, end })),
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
		value: cell.state === 'measured' ? noticeTotal(cell.value) : null,
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
