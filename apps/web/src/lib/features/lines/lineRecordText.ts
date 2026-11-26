import { intl, type Locale } from '#lib/i18n/index.ts';
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
	recordPercent,
	citeDates,
	dateRange,
	methodEvidence,
	scheduleHours,
	serviceTime,
} from '#lib/site/presenter.ts';
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
	alerts: ['Agency notices on these dates', 'Avis de la société de transport à ces dates'],
	frequency: ['Planned frequency', 'Fréquence prévue'],
	boundaries: ['First and last trips', 'Premiers et derniers trajets'],
} satisfies Record<LineSection, [string, string]>;

export function lineTimetableOnly(answer: RecordMeasure | null) {
	return (
		answer?.state === 'no_live_data' ||
		(answer?.state === 'not_measured' && !answer.evidence.counts.classified)
	);
}

export function deliveryFinding(answer: RecordSeries, locale: Locale) {
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
		`${failures} of ${total} scheduled trips did not run: ${a} cancelled by the agency and ${m} missing, with no vehicle and no notice.`,
		`${failures} des ${total} trajets prévus n’ont pas été effectués\u00a0: ${a} annulés par la société de transport et ${m} manquants, sans véhicule ni avis.`,
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
		`The ${time} departure${end ? ` ${end}` : ''} ranked first, with ${value} of its observed stop events late.`,
		`Le départ de ${time}${end ? ` ${end}` : ''} se classe premier, avec ${value} de ses passages observés aux arrêts en retard.`,
	);
}

export function waitingFinding(answer: RecordMeasure, locale: Locale) {
	const excess = waitingReadingParts(answer, 'excess_wait_time', locale);
	if (excess.value && excess.detail)
		return choose(
			locale,
			`Excess wait time was ${excess.value} in comparable frequent-service windows.`,
			`L’attente excédentaire était de ${excess.value} dans les périodes comparables de service fréquent.`,
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
	const rate = intl.number(locale, { maximumFractionDigits: 2 }).format(peak.rate);
	const hours = scheduleHours(peak.hour, peak.hour + 1, locale);
	return choose(
		locale,
		`Planned service peaked at ${rate} trips per hour from ${hours}.`,
		`Le service prévu atteignait un maximum de ${rate} trajets par heure de ${hours}.`,
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
		`${value} of observed stop events were on time (${n} of ${total})`,
		`${value} des passages observés aux arrêts étaient à l’heure (${n} sur ${total})`,
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
