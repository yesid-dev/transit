import { intl, type Locale } from '#lib/i18n/index.ts';
import type { EngineResult, MeasureAnswer, RankingAnswer } from '#lib/server/engine.ts';
import { addIsoDays } from '#lib/v1/history/selection.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';

import {
	dateRange,
	methodEvidence,
	percent,
	recordConnection,
	tally,
} from '../record/recordText.ts';
export { dateRange, percent, tally };

const DAY_MS = 86_400_000;

export function previousPeriod({ from, to }: DateWindow): DateWindow {
	const days = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
	return { from: addIsoDays(from, -days), to: addIsoDays(from, -1) };
}

export function measureText(
	result: EngineResult<MeasureAnswer>,
	period: DateWindow,
	locale: Locale,
): string {
	if (result.kind !== 'answer') return recordConnection[result.kind][locale];
	const answer = result.answer;
	if (answer.state !== 'measured') return answer.state_text[locale];

	const value = answer.value[answer.measure];
	const { on_time, classified, ran, eligible } = answer.evidence.counts;
	const punctuality = answer.measure === 'on_time';
	const [top, bottom] = punctuality ? [on_time, classified] : [ran, eligible];
	if (value == null || top == null || bottom == null || bottom === 0)
		return recordConnection.unreachable[locale];

	const share = percent(value, locale);
	const dates = dateRange(period, locale);
	const n = tally(top, locale);
	const total = tally(bottom, locale);
	if (punctuality) {
		return locale === 'fr'
			? `${dates}, ${share} des passages observés aux arrêts étaient à l’heure (${n} sur ${total}).`
			: `${dates}, ${share} of observed stop events were on time (${n} of ${total}).`;
	}
	return locale === 'fr'
		? `${dates}, ${share} des trajets prévus dont le résultat est connu ont été effectués (${n} sur ${total}).`
		: `${dates}, ${share} of scheduled trips with a known outcome ran (${n} of ${total}).`;
}

export function comparisonText(
	current: EngineResult<MeasureAnswer>,
	previous: EngineResult<MeasureAnswer>,
	locale: Locale,
): string | null {
	if (current.kind !== 'answer' || previous.kind !== 'answer') return null;
	if (current.answer.state !== 'measured' || previous.answer.state !== 'measured') return null;
	const now = current.answer.value.on_time;
	const then = previous.answer.value.on_time;
	if (now == null || then == null) return null;
	const points = (now - then) * 100;
	const magnitude = Math.round(Math.abs(points) * 10) / 10;
	if (magnitude === 0)
		return locale === 'fr'
			? 'Aucun écart au dixième de point près.'
			: 'No change to the nearest tenth of a point.';
	const n = intl.number(locale, { signDisplay: 'always', maximumFractionDigits: 1 }).format(points);
	return locale === 'fr'
		? `Écart de ${n} ${magnitude < 2 ? 'point' : 'points'} de pourcentage.`
		: `Change of ${n} percentage ${magnitude === 1 ? 'point' : 'points'}.`;
}

export function rankingText(result: EngineResult<RankingAnswer>, locale: Locale): string | null {
	if (result.kind !== 'answer') return recordConnection[result.kind][locale];
	const { rows, state_text, excluded, evidence } = result.answer;
	if (rows.length) return null;
	if (state_text) return state_text[locale];
	const reason = excluded[0];
	if (reason && excluded.every((entry) => entry.reason === reason.reason))
		return reason.reason_text[locale];
	if (!evidence.days_included.length)
		return locale === 'fr' ? 'Non mesuré à ces dates' : 'Not measured on those dates';
	return locale === 'fr' ? 'Inconnu' : 'Unknown';
}

export function citationText(answer: MeasureAnswer, period: DateWindow, locale: Locale): string {
	const reading = measureText({ kind: 'answer', answer }, period, locale);
	return `${reading} ${methodEvidence(answer.evidence, locale)}`;
}
