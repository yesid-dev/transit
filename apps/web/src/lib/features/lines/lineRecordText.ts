import type { Locale } from '#lib/i18n/index.ts';
import type {
	DepartureRanking,
	RecordAnswer,
	RecordCell,
	RecordEvidence,
} from '#lib/server/engine.ts';
import {
	choose,
	dateRange,
	methodEvidence,
	percent,
	rateStateText,
	timingBasis,
	withCoverage,
	tally,
} from '#lib/features/record/recordText.ts';
import type { LineDirection, LineSection } from '#lib/server/lineRecord.ts';

export const lineSectionTitles = {
	waiting: ['Waiting and gaps', 'Attente et intervalles'],
	offered: ['Service offered', 'Service offert'],
	punctuality: ['On-time performance', 'Ponctualité'],
	daily: ['Day by day', 'Jour par jour'],
	hourly: ['By hour and weekday', 'Par heure et jour de la semaine'],
	directions: ['Each direction', 'Par direction'],
	stops: ['Delay along its stops', 'Retard le long de ses arrêts'],
	delivery: [
		'Cancelled and missing trips, by departure',
		'Trajets annulés et manquants, par départ',
	],
	late: ['Departures late most often', 'Départs le plus souvent en retard'],
	crowding: ['Crowding', 'Achalandage'],
	alerts: ['Agency notices on these dates', 'Avis de l’agence à ces dates'],
	frequency: ['Planned frequency', 'Fréquence prévue'],
	boundaries: ['First and last trips', 'Premiers et derniers trajets'],
} satisfies Record<LineSection, [string, string]>;

export function lineAnswer(cell: RecordCell, evidence: RecordEvidence, locale: Locale): string {
	if (cell.state !== 'measured') return rateStateText(cell, locale);
	const share = cell.value.on_time;
	const { on_time, classified } = cell.evidence.counts;
	if (share == null || on_time == null || !classified) return choose(locale, 'Unknown', 'Inconnu');
	const dates = dateRange({ from: evidence.start_date, to: evidence.end_date }, locale);
	const value = percent(share, locale);
	const n = tally(on_time, locale);
	const total = tally(classified, locale);
	const reading = choose(
		locale,
		`${dates}, ${value} of observed stop events were on time (${n} of ${total})`,
		`${dates}, ${value} des passages observés aux arrêts étaient à l’heure (${n} sur ${total})`,
	);
	return `${withCoverage(reading, cell.evidence, locale)}.`;
}

export function lineCitation(
	subject: string,
	section: string,
	answer: RecordAnswer,
	locale: Locale,
	href: string,
): string {
	const evidence = answer.evidence;
	const dates = dateRange({ from: evidence.start_date, to: evidence.end_date }, locale);
	return [
		`Transit · ${subject}. ${section}. ${dates}.`,
		'value' in answer && section === choose(locale, ...lineSectionTitles.punctuality)
			? lineAnswer(answer, evidence, locale)
			: '',
		methodEvidence(evidence, locale),
		href,
	]
		.filter(Boolean)
		.join(' ');
}

export function lateDepartureReading(row: DepartureRanking['rows'][number], locale: Locale) {
	const rate = percent(row.value, locale);
	const total = tally(row.sample, locale);
	const late = row.counts.late;
	const reading =
		late == null
			? choose(locale, `${rate} (${total} observations)`, `${rate} (${total} observations)`)
			: `${rate} (${tally(late, locale)}/${total})`;
	return [withCoverage(reading, row, locale), timingBasis(row.counts, locale)]
		.filter(Boolean)
		.join('. ');
}

export function directionLabel(
	direction: string | number | null | undefined,
	headsigns: Record<number, string>,
	locale: Locale,
) {
	if (direction == null) return choose(locale, 'Unknown direction', 'Direction inconnue');
	const name = headsigns[Number(direction)];
	return name
		? choose(locale, `Toward ${name}`, `Vers ${name}`)
		: `${choose(locale, 'Direction', 'Direction')} ${direction}`;
}

export function lineViewHref(
	url: URL,
	view: 'record' | 'schedule' | 'live',
	direction?: LineDirection,
) {
	const target = new URL(url);
	target.hash = '';
	target.searchParams.set('frameMode', view === 'live' ? 'live' : 'record');
	target.searchParams.delete('tab');
	if (view === 'live') target.searchParams.set('tab', 'detail');
	if (view === 'schedule') target.searchParams.set('tab', 'schedule');
	if (direction !== undefined) {
		target.searchParams.delete('direction');
		if (direction !== null) target.searchParams.set('direction', direction);
	}
	return target;
}
