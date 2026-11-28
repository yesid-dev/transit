import type { Locale } from '#lib/i18n/index.ts';
import type {
	DepartureRanking,
	RecordAnswer,
	RecordCell,
	RecordEvidence,
	RecordMeasure,
	RecordSeries,
} from '#lib/server/engine.ts';
import {
	choose,
	rateStateText,
	timingBasis,
	withCoverage,
	tally,
} from '#lib/features/record/recordText.ts';
import { waitingReadingParts } from '#lib/features/record/waitingText.ts';
import {
	countedUnit,
	frenchAgency,
	recordPercent,
	citeDates,
	type AgencyName,
	dateRange,
	methodEvidence,
	scheduleHours,
	serviceTime,
	tripsAnHour,
} from '#lib/site/presenter.ts';
import type { LineDirection, LineSection } from '#lib/server/lineRecord.ts';

export const lineSectionTitles = {
	waiting: ['Waiting and gaps', 'Attente et intervalles'],
	offered: ['Service offered', 'Service offert'],
	punctuality: ['On-time share', 'Ponctualité'],
	daily: ['Day by day', 'Jour par jour'],
	hourly: ['By hour and weekday', 'Par heure et jour de la semaine'],
	directions: ['Each direction', 'Par direction'],
	stops: ['Delay along the line', 'Retard le long de la ligne'],
	delivery: [
		'Cancelled and missing trips, by departure',
		'Trajets annulés et manquants, par départ',
	],
	late: ['Departures late most often', 'Départs le plus souvent en retard'],
	crowding: ['Room on board', 'Places à bord'],
	alerts: ['Service alerts on these dates', 'Avis de service à ces dates'],
	frequency: ['Planned frequency', 'Fréquence prévue'],
	boundaries: ['First and last trips', 'Premiers et derniers trajets'],
} satisfies Record<LineSection, [string, string]>;

export function lineTimetableOnly(answer: RecordMeasure | null) {
	return (
		answer?.state === 'no_live_data' ||
		(answer?.state === 'not_measured' && !answer.evidence.counts.classified)
	);
}

export function deliveryFinding(answer: RecordSeries, locale: Locale, agency?: AgencyName | null) {
	if (!answer.cells.length || answer.evidence.days_not_measured.length) return null;
	let scheduled = 0;
	let cancelled = 0;
	let missing = 0;
	// Departure and direction partition the selected timetable. Require every cell's counts.
	for (const cell of answer.cells) {
		const counts = cell.evidence.counts;
		if (
			(cell.state !== 'measured' && cell.state !== 'too_few_to_judge') ||
			counts.scheduled == null ||
			counts.cancelled == null ||
			counts.missing == null
		)
			return null;
		scheduled += counts.scheduled;
		cancelled += counts.cancelled;
		missing += counts.missing;
	}
	const total = tally(scheduled, locale);
	const failures = tally(cancelled + missing, locale);
	const a = tally(cancelled, locale);
	const m = tally(missing, locale);
	return choose(
		locale,
		`${failures} of ${total} scheduled trips did not run: ${a} cancelled by ${agency?.name ?? 'the agency'} and ${m} missing, with no vehicle and no notice.`,
		`${failures} des ${total} trajets prévus n’ont pas été effectués\u00a0: ${a} annulés ${agency ? frenchAgency(agency).by : 'par la société de transport'} et ${m} manquants, sans véhicule ni avis.`,
	);
}

/**
 * Some departures are measured but the whole period has no total (a day was not measured): say
 * what the table shows instead of a "Not measured" mark above measured rows.
 */
export function deliveryPartialNote(answer: RecordSeries, locale: Locale) {
	const days = answer.evidence.days_measured.length;
	return choose(
		locale,
		`Showing departures with enough scheduled trips to judge, over ${countedUnit(days, 'day', locale)} measured.`,
		`Départs comptant assez de trajets prévus pour conclure, sur ${countedUnit(days, 'day', locale)} ${days === 1 ? 'mesuré' : 'mesurés'}.`,
	);
}

export function departureFinding(
	answer: DepartureRanking,
	end: string | undefined,
	locale: Locale,
) {
	const top = answer.rows[0];
	const time = serviceTime(top?.departure, locale);
	if (!top || !time) return null;
	const value = recordPercent(top.value, locale);
	return choose(
		locale,
		`The ${time} departure${end ? ` ${end}` : ''} ranked first, with ${value} of its recorded stop arrivals late.`,
		`Le départ de ${time}${end ? ` ${end}` : ''} se classe premier, avec ${value} de ses passages enregistrés aux arrêts en retard.`,
	);
}

export function waitingFinding(answer: RecordMeasure, locale: Locale) {
	const excess = waitingReadingParts(answer, 'excess_wait_time', locale);
	if (excess.measured)
		return choose(
			locale,
			`On the gaps Transit could measure, estimated waits were ${excess.value} longer than scheduled.`,
			`Pour les intervalles que Transit a pu mesurer, l’attente estimée dépassait l’horaire de ${excess.value}.`,
		);
	const gaps = waitingReadingParts(answer, 'long_gaps', locale);
	if (gaps.detail)
		return choose(
			locale,
			`Long gaps accounted for ${gaps.value} of observed intervals.`,
			`Les intervalles prolongés représentaient ${gaps.value} des intervalles observés.`,
		);
	const bunching = waitingReadingParts(answer, 'bunching', locale);
	return bunching.detail
		? choose(
				locale,
				`Vehicle bunching accounted for ${bunching.value} of observed intervals.`,
				`Les regroupements de véhicules représentaient ${bunching.value} des intervalles observés.`,
			)
		: null;
}

const crowdingPhrases: Record<string, [en: string, fr: string]> = {
	crowding_empty: ['were empty', 'étaient vides'],
	crowding_many_seats: ['had many seats available', 'avaient plusieurs places assises libres'],
	crowding_few_seats: ['had few seats available', 'avaient peu de places assises libres'],
	crowding_standing: ['had standing room only', 'n’avaient que des places debout'],
	crowding_crushed: ['had little standing room', 'avaient peu de places debout'],
	crowding_full: ['were full', 'étaient pleins'],
};

/** The most frequent occupancy in a rider's words: "Vehicles most often had few seats available: 33.9% of the time." */
export function crowdingFinding(
	level: { key: string; share: number; percentage?: number },
	locale: Locale,
) {
	const share = recordPercent(level.share, locale);
	const phrase =
		level.key === 'percentage' && level.percentage != null
			? choose(
					locale,
					`were reported ${recordPercent(level.percentage / 100, locale)} full`,
					`étaient déclarés pleins à ${recordPercent(level.percentage / 100, locale)}`,
				)
			: crowdingPhrases[level.key]
				? choose(locale, ...crowdingPhrases[level.key])
				: null;
	if (!phrase) return null;
	return choose(
		locale,
		`Vehicles most often ${phrase}: ${share} of the time.`,
		`Les véhicules ${phrase.replace(/^(\S+)/u, '$1 le plus souvent')}\u00a0: ${share} du temps.`,
	);
}

export function offeredFinding(answer: RecordSeries, locale: Locale) {
	let peak: { hour: number; rate: number } | undefined;
	for (const cell of answer.cells) {
		const { hour } = cell.key;
		const rate = cell.value.scheduled_frequency;
		if (cell.state === 'measured' && hour != null && rate != null && (!peak || rate > peak.rate)) {
			peak = { hour: Number(hour), rate };
		}
	}
	if (!peak) return null;
	if (peak.rate === 0)
		return choose(
			locale,
			'The timetable scheduled no trips in the available hours.',
			'L’horaire ne prévoyait aucun trajet dans les heures disponibles.',
		);
	const rate = tripsAnHour(peak.rate, locale).toLocaleLowerCase(locale);
	const hours = scheduleHours(peak.hour, peak.hour + 1, locale);
	return choose(
		locale,
		`Planned service peaked from ${hours}: ${rate}.`,
		`Le service prévu culminait de ${hours}\u00a0: ${rate}.`,
	);
}

export function delayBuilds(cells: RecordSeries['cells']) {
	let largest: { from: number; to: number; seconds: number } | undefined;
	let start = 0;
	for (let to = 1; to < cells.length; to++) {
		const from = to - 1;
		const a = cells[from];
		const b = cells[to];
		const sequence = Number(a.key.stop_sequence);
		const nextSequence = Number(b.key.stop_sequence);
		const early = a.value.median_delay;
		const late = b.value.median_delay;
		if (
			typeof a.key.stop !== 'string' ||
			typeof b.key.stop !== 'string' ||
			a.key.direction !== b.key.direction ||
			Number(cells[from - 1]?.key.stop_sequence) === sequence ||
			Number(cells[to + 1]?.key.stop_sequence) === nextSequence ||
			!(nextSequence > sequence) ||
			a.state !== 'measured' ||
			b.state !== 'measured' ||
			early == null ||
			late == null ||
			late <= early
		) {
			start = to;
			continue;
		}
		const seconds = late - cells[start].value.median_delay!;
		if (seconds > (largest?.seconds ?? 0)) largest = { from: start, to, seconds };
	}
	return largest;
}

export function lineAnswer(
	cell: RecordCell,
	evidence: RecordEvidence,
	locale: Locale,
	withDates = true,
): string {
	if (cell.state !== 'measured') return rateStateText(cell, locale);
	const share = cell.value.on_time;
	const { on_time, classified } = cell.evidence.counts;
	if (share == null || on_time == null || !classified) return choose(locale, 'Unknown', 'Inconnu');
	const dates = dateRange({ from: evidence.start_date, to: evidence.end_date }, locale);
	const value = recordPercent(share, locale);
	const n = tally(on_time, locale);
	const total = tally(classified, locale);
	const reading = choose(
		locale,
		`${value} of recorded stop arrivals were on time (${n} of ${total})`,
		`${value} des passages enregistrés aux arrêts étaient à l’heure (${n} sur ${total})`,
	);
	const dated = withDates ? `${dates}, ${reading}` : reading;
	return `${withCoverage(dated, cell.evidence, locale)}.`;
}

export function lineCitation(
	subject: string,
	section: string,
	answer: RecordAnswer,
	locale: Locale,
	href: string,
): string {
	const evidence = answer.evidence;
	const dates = citeDates({ from: evidence.start_date, to: evidence.end_date }, locale);
	return [
		`Transit · ${subject}. ${section}. ${dates}.`,
		'value' in answer && section === choose(locale, ...lineSectionTitles.punctuality)
			? lineAnswer(answer, evidence, locale, false)
			: '',
		methodEvidence(evidence, locale),
		href,
	]
		.filter(Boolean)
		.join(' ');
}

export function lateDepartureReading(row: DepartureRanking['rows'][number], locale: Locale) {
	const rate = recordPercent(row.value, locale);
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
