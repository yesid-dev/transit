import { intl, type Locale } from '#lib/i18n/index.ts';
import {
	choose,
	lastGoodNote,
	measuredShare,
	rateStateText,
	withCoverage,
	tally,
} from '#lib/features/record/recordText.ts';
import {
	recordPercent,
	countedUnit,
	dateRange,
	methodEvidence,
	singularCount,
} from '#lib/site/presenter.ts';
import { recordState } from '../record/recordStates.ts';
import type {
	EngineResult,
	RecordAnswer,
	RecordCell,
	RecordMeasure,
	RecordSeries,
} from '#lib/server/engine.ts';
import type { loadStopRecord, StopSection } from '#lib/server/stopRecord.ts';

export function stopLowCoverage(result: EngineResult<RecordAnswer>) {
	return (
		result.kind === 'answer' &&
		'value' in result.answer &&
		result.answer.state === 'not_measured' &&
		result.answer.evidence.coverage_reason === 'insufficient_coverage'
	);
}

export async function stopArchiveAvailability(record: ReturnType<typeof loadStopRecord>) {
	const results = await Promise.all([...record.sections.map(({ answer }) => answer), record.grid]);
	const hasReading = (answer: RecordMeasure | RecordSeries | RecordSeries['cells'][number]) =>
		('counts' in answer.evidence &&
			Object.values(answer.evidence.counts).some((value) => value != null && value > 0)) ||
		('value' in answer &&
			answer.state === 'measured' &&
			Object.values(answer.value).some((value) => typeof value === 'number' && value !== 0));
	if (
		results.some(
			(result) =>
				result.kind === 'answer' &&
				('value' in result.answer || 'cells' in result.answer) &&
				(hasReading(result.answer) ||
					('cells' in result.answer && result.answer.cells.some(hasReading))),
		)
	)
		return 'available';
	if (results.some((result) => result.kind === 'busy')) return 'busy';
	return results.every((result) => result.kind === 'answer') ? 'empty' : 'unavailable';
}

export const stopSectionTitles = {
	waiting: ['Waiting by line', 'Attente par ligne'],
	punctuality: ['On-time performance', 'Ponctualité'],
	byLine: ['By line', 'Par ligne'],
	hourly: ['By hour', 'Par heure'],
	daily: ['Day by day', 'Jour par jour'],
	delay: ['Typical delay', 'Retard typique'],
	accessibility: ['Wheelchair boarding', 'Embarquement en fauteuil roulant'],
	alerts: ['Alerts for this stop', 'Avis pour cet arrêt'],
} satisfies Record<StopSection, [string, string]>;

export function stopEvidenceSample(
	answer: RecordMeasure | RecordSeries,
	section: StopSection,
	locale: Locale,
) {
	const unit = section === 'waiting' ? 'observed_headways' : 'classified';
	const counts =
		'cells' in answer
			? answer.cells.flatMap(({ evidence }) => evidence.counts[unit] ?? [])
			: [answer.evidence.counts[unit]].filter((count) => count != null);
	const total = counts.length ? counts.reduce((sum, count) => sum + count, 0) : null;
	const trips =
		'value' in answer
			? (answer.evidence.trip_ids?.length ?? answer.evidence.counts.observed_trips)
			: null;
	const days = answer.evidence.days_included.length;
	const intervals =
		total === null
			? null
			: choose(
					locale,
					`${tally(total, locale)} observed ${singularCount(total, locale) ? 'interval' : 'intervals'}`,
					`${tally(total, locale)} ${singularCount(total, locale) ? 'intervalle observé' : 'intervalles observés'}`,
				);
	return [
		section === 'waiting'
			? intervals
			: section === 'alerts' || total === null
				? null
				: countedUnit(total, 'event', locale),
		section === 'punctuality' || section === 'delay'
			? trips == null
				? null
				: countedUnit(trips, 'trip', locale)
			: null,
		days ? countedUnit(days, 'day', locale) : null,
	]
		.filter(Boolean)
		.join(', ');
}

export function stopAnswer(answer: RecordMeasure, locale: Locale): string {
	if (answer.state !== 'measured') return rateStateText(answer, locale);
	const share = answer.value.on_time;
	const { on_time, classified } = answer.evidence.counts;
	if (share == null || on_time == null || !classified) return choose(locale, 'Unknown', 'Inconnu');
	const dates = dateRange(
		{ from: answer.evidence.start_date, to: answer.evidence.end_date },
		locale,
	);
	const value = recordPercent(share, locale);
	const onTime = tally(on_time, locale);
	const total = tally(classified, locale);
	const reading = choose(
		locale,
		`${dates}, ${value} of observed stop events here were on time (${onTime} of ${total})`,
		`${dates}, ${value} des passages observés à cet arrêt étaient à l’heure (${onTime} sur ${total})`,
	);
	return `${withCoverage(reading, answer.evidence, locale)}.`;
}

export function stopCoverageGap(
	answer: Pick<RecordCell, 'state' | 'evidence'>,
	locale: Locale,
	waiting = false,
	minimum?: number,
) {
	if (answer.state === 'measured' || answer.evidence.coverage_reason !== 'insufficient_coverage')
		return null;

	const { counts } = answer.evidence;
	const observed = waiting ? counts.observed_headways : counts.classified;
	const scheduled = waiting ? counts.frequent_headways : counts.scheduled;
	const sample =
		observed != null && scheduled
			? choose(
					locale,
					`${tally(observed, locale)} of ${tally(scheduled, locale)}`,
					`${tally(observed, locale)} sur ${tally(scheduled, locale)}`,
				)
			: null;
	const floor =
		minimum == null
			? null
			: choose(
					locale,
					`minimum ${recordPercent(minimum, locale)}`,
					`minimum de ${recordPercent(minimum, locale)}`,
				);
	const detail = [sample, floor].filter(Boolean).join(', ');
	const sentence = waiting
		? choose(
				locale,
				'Too few scheduled intervals were observed',
				'Trop peu d’intervalles prévus ont été observés',
			)
		: choose(
				locale,
				'There are too few observed stop events to measure punctuality for these dates',
				'Il y a trop peu de passages observés pour mesurer la ponctualité à ces dates',
			);
	return detail ? `${sentence} (${detail}).` : `${sentence}.`;
}

export const stopAccessibilityDescription = {
	en: 'This is what the agency declared for this stop in the schedule on its latest service date in the selection.',
	fr: 'Il s’agit de la déclaration de l’exploitant dans l’horaire pour cet arrêt à sa dernière date de service dans la période choisie.',
};

export function stopBoardingNotPublished(answer: RecordMeasure) {
	return answer.state === 'not_published' || answer.evidence.counts.stops_no_information === 1;
}

export function stopAccessibility(answer: RecordMeasure, locale: Locale): string {
	if (stopBoardingNotPublished(answer)) return recordState('not_published')[locale];
	if (answer.state !== 'measured') return answer.state_text[locale];
	const { stops_accessible, stops_not_accessible } = answer.evidence.counts;
	if (stops_accessible === 1) return choose(locale, 'Accessible', 'Accessible');
	if (stops_not_accessible === 1) return choose(locale, 'Not accessible', 'Non accessible');
	return choose(locale, 'Unknown', 'Inconnu');
}

export function stopCitation(
	subject: string,
	section: StopSection,
	answer: RecordAnswer,
	locale: Locale,
	href: string,
	lastGood?: true,
): string {
	const { evidence } = answer;
	const dates = dateRange({ from: evidence.start_date, to: evidence.end_date }, locale);
	return [
		`Transit · ${subject}. ${choose(locale, ...stopSectionTitles[section])}. ${dates}.`,
		section === 'punctuality' && 'value' in answer ? stopAnswer(answer, locale) : '',
		section === 'accessibility' && 'value' in answer
			? `${stopAccessibilityDescription[locale]} ${stopAccessibility(answer, locale)}.`
			: '',
		methodEvidence(evidence, locale),
		lastGood ? lastGoodNote[locale] : '',
		href,
	]
		.filter(Boolean)
		.join(' ');
}

export function stopComparison(
	stop: RecordMeasure,
	network: EngineResult<RecordAnswer>,
	locale: Locale,
) {
	if (network.kind !== 'answer' || !('value' in network.answer)) return undefined;
	if (
		stop.evidence.start_date !== network.answer.evidence.start_date ||
		stop.evidence.end_date !== network.answer.evidence.end_date
	)
		return undefined;
	const stopShare = measuredShare(stop, 'on_time');
	const networkShare = measuredShare(network.answer, 'on_time');
	if (stopShare == null || networkShare == null) return undefined;
	const difference = Math.round(Math.abs(stopShare - networkShare) * 1000) / 10;
	const points = intl.number(locale, { maximumFractionDigits: 1 }).format(difference);
	const baseline = recordPercent(networkShare, locale);
	if (difference === 0)
		return choose(
			locale,
			`The network was also at ${baseline} over the same dates.`,
			`Le réseau était aussi à ${baseline} sur les mêmes dates.`,
		);
	const relation = stopShare < networkShare ? ['below', 'sous'] : ['above', 'au-dessus de'];
	const unit = difference === 1 ? 'point' : 'points';
	return choose(
		locale,
		`${points} ${unit} ${relation[0]} the network, which was at ${baseline} over the same dates.`,
		`${points} ${unit} ${relation[1]} la part du réseau, qui était de ${baseline} sur les mêmes dates.`,
	);
}
