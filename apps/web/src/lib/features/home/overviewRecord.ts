import { intl, type Locale } from '#lib/i18n/index.ts';
import type { EngineResult, MeasureAnswer, RankingAnswer } from '#lib/server/engine.ts';
import { addIsoDays } from '#lib/v1/history/selection.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';

const DAY_MS = 86_400_000;

export function previousPeriod({ from, to }: DateWindow): DateWindow {
	const days = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
	return { from: addIsoDays(from, -days), to: addIsoDays(from, -1) };
}

export function dateRange({ from, to }: DateWindow, locale: Locale): string {
	const date = intl.dateTime(locale, { dateStyle: 'long', timeZone: 'UTC' });
	const start = new Date(from);
	const end = new Date(to);
	if (from === to) {
		const day = date.format(start);
		return locale === 'fr' ? `Le ${day}` : `On ${day}`;
	}
	const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
	const sameMonth = sameYear && start.getUTCMonth() === end.getUTCMonth();
	const monthDay = intl.dateTime(locale, { month: 'long', day: 'numeric', timeZone: 'UTC' });
	if (locale === 'fr') {
		const first = start.getUTCDate() === 1 ? '1er' : start.getUTCDate();
		const beginning = sameMonth ? first : sameYear ? monthDay.format(start) : date.format(start);
		return `Du ${beginning} au ${date.format(end)}`;
	}
	const beginning = sameYear ? monthDay.format(start) : date.format(start);
	return `From ${beginning} to ${sameMonth ? `${end.getUTCDate()}, ${end.getUTCFullYear()}` : date.format(end)}`;
}

export function percent(value: number, locale: Locale): string {
	return intl.number(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value);
}

export function tally(value: number, locale: Locale): string {
	return intl.number(locale, { maximumFractionDigits: 0 }).format(value);
}

const connection = {
	unconfigured: {
		en: 'The record view is being connected. Numbers will appear here.',
		fr: 'Le bilan sera bientôt relié aux données. Les chiffres s’afficheront ici.',
	},
	unreachable: {
		en: 'The record is temporarily unavailable.',
		fr: 'Le bilan est temporairement indisponible.',
	},
	timeout: {
		en: 'The record took too long to load. Try again later.',
		fr: 'Le bilan a pris trop de temps à charger. Réessayez plus tard.',
	},
};

export function measureText(
	result: EngineResult<MeasureAnswer>,
	period: DateWindow,
	locale: Locale,
): string {
	if (result.kind !== 'answer') return connection[result.kind][locale];
	const answer = result.answer;
	if (answer.state !== 'measured') return answer.state_text[locale];

	const value = answer.value[answer.measure];
	const { on_time, classified, ran, eligible } = answer.evidence.counts;
	const punctuality = answer.measure === 'on_time';
	const [top, bottom] = punctuality ? [on_time, classified] : [ran, eligible];
	if (value == null || top == null || bottom == null || bottom === 0)
		return connection.unreachable[locale];

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
	if (result.kind !== 'answer') return connection[result.kind][locale];
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
	const { method_version, cleaning_versions } = answer.evidence;
	const reading = measureText({ kind: 'answer', answer }, period, locale);
	const versions = cleaning_versions.join(', ');
	return locale === 'fr'
		? `${reading} Méthode ${method_version}. Nettoyage des données, version ${versions}.`
		: `${reading} Method ${method_version}. Data cleaning version ${versions}.`;
}
