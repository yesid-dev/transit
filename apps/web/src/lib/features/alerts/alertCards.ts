import type { Locale } from '#lib/i18n/index.ts';
import type { RecordMeasure, RecordSeries } from '#lib/server/engine.ts';
import type { AgencyMessage, AgencyMessagePeriod } from '#lib/site/agencyMessages.ts';
import { effectLabel } from '#lib/v1/gtfsAlertLabels.ts';
import type { CaptureSnapshot } from '#lib/live/captureSnapshot.ts';

export type AlertCard = AgencyMessage & {
	key: string;
	id: string;
	stops: readonly string[];
	effect: string | null;
	periods: readonly AgencyMessagePeriod[];
};

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
