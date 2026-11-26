import type { Locale } from '#lib/i18n/index.ts';
import type { RecordCell, RecordSeries } from '#lib/server/engine.ts';
import { choose, rateStateText, tally, withCoverage } from './recordText.ts';
import {
	countedUnit,
	dateRange,
	reportHours,
	recordPercent,
	sampleWithMinimum,
} from '#lib/site/presenter.ts';
import { recordStateFor, type RecordState } from './recordStates.ts';

export const dailyTitles = {
	punctuality: ['On-time share', 'Part des passages à l’heure'],
	delivery: [
		'Service delivered against scheduled',
		'Service effectué par rapport au service prévu',
	],
	periods: ['The day in five periods', 'La journée en cinq périodes'],
	lines: ['Lines to inspect', 'Lignes à examiner'],
	stops: ['Stops to inspect', 'Arrêts à examiner'],
	messages: ['Agency messages', 'Avis de la société de transport'],
} as const;

export const departureTitles = {
	observed: [
		'Days observed and days with a late stop',
		'Jours observés et jours avec un arrêt en retard',
	],
	delay: ['Typical delay', 'Retard typique'],
	stops: ['Stop by stop', 'Arrêt par arrêt'],
	missed: ['Cancelled and missing departures', 'Départs annulés et manquants'],
} as const;

export function onTimeStatement(cell: RecordCell, locale: Locale) {
	if (cell.state !== 'measured') return rateStateText(cell, locale);
	const rate = cell.value.on_time;
	const { on_time, classified } = cell.evidence.counts;
	if (rate == null || on_time == null || !classified) return choose(locale, 'Unknown', 'Inconnu');
	const share = recordPercent(rate, locale);
	const top = tally(on_time, locale);
	const total = tally(classified, locale);
	const reading = choose(
		locale,
		`${share} of observed stop events were on time (${top} of ${total})`,
		`${share} des passages observés étaient à l’heure (${top} sur ${total})`,
	);
	return `${withCoverage(reading, cell.evidence, locale)}.`;
}

export function departureDays({ cells, evidence }: RecordSeries) {
	const included = new Set(evidence.days_included);
	const observed = cells.filter(
		(cell) =>
			typeof cell.key.day === 'string' &&
			included.has(cell.key.day) &&
			(cell.state === 'measured' || cell.state === 'too_few_to_judge') &&
			(cell.evidence.counts.classified ?? 0) > 0,
	);
	return {
		observed: observed.length,
		late: observed.filter(({ evidence }) => (evidence.counts.late ?? 0) > 0).length,
	};
}

const periods = [
	{ start: 5, end: 7, en: 'Early morning', fr: 'Tôt le matin' },
	{ start: 7, end: 10, en: 'Morning peak', fr: 'Pointe du matin' },
	{ start: 10, end: 15, en: 'Midday', fr: 'Milieu de journée' },
	{ start: 15, end: 19, en: 'Afternoon peak', fr: 'Pointe de l’après-midi' },
	{ start: 19, end: 5, en: 'Evening and night', fr: 'Soirée et nuit' },
];

export function dailyPeriods(answer: RecordSeries | null, locale: Locale) {
	const info = answer?.info?.[0];
	return periods.map(({ start, end, en, fr }) => {
		const hours =
			answer?.cells.filter(({ key }) => {
				const hour = key.hour;
				return (
					typeof hour === 'number' &&
					(start < end ? hour >= start && hour < end : hour >= start || hour < end)
				);
			}) ?? [];
		const sum = (field: string) =>
			hours.reduce((total, cell) => total + (cell.evidence.counts[field] ?? 0), 0);
		const classified = sum('classified');
		const late = sum('late');
		const missingLateCount = hours.some(
			({ evidence: { counts } }) => counts.classified && counts.late == null,
		);
		const scheduled = sum('scheduled');
		const coverage = scheduled > 0 ? classified / scheduled : null;
		const observed = hours.find((hour) => hour.state !== 'unknown') ?? hours[0];
		let state: RecordState | null = null;
		let detail: string | null = null;
		if (coverage != null && info?.minimum_coverage != null && coverage < info.minimum_coverage) {
			state = 'not_measured';
			detail = choose(locale, 'Insufficient coverage', 'Couverture insuffisante');
		} else if (!classified) {
			state = recordStateFor(observed?.state ?? answer?.state ?? 'not_measured');
		} else if (!info || missingLateCount || (info.minimum_coverage != null && coverage == null)) {
			state = 'unknown';
		} else if (classified < info.minimum_sample) {
			state = 'too_few_to_judge';
			detail = sampleWithMinimum(
				countedUnit(classified, 'event', locale),
				info.minimum_sample,
				locale,
			);
		}
		return {
			start,
			label: choose(locale, en, fr),
			hours: reportHours(start, end, locale),
			value: state ? null : recordPercent(late / classified, locale),
			count: classified ? tally(classified, locale) : null,
			state,
			detail,
		};
	});
}

export function shortDay(day: string, locale: Locale) {
	return dateRange({ from: day, to: day }, locale);
}

/**
 * The departure's answer: the late share of its observed stop events, pooled over
 * the same observed days as departureDays. A day late at one stop of forty weighs
 * one fortieth of a day late at all forty; the days count stays as detail.
 */
export function departureLateShare(answer: RecordSeries) {
	const included = new Set(answer.evidence.days_included);
	let classified = 0;
	let late = 0;
	for (const cell of answer.cells)
		if (
			typeof cell.key.day === 'string' &&
			included.has(cell.key.day) &&
			(cell.state === 'measured' || cell.state === 'too_few_to_judge')
		) {
			classified += cell.evidence.counts.classified ?? 0;
			late += cell.evidence.counts.late ?? 0;
		}
	const minimum = answer.info?.[0]?.minimum_sample;
	const enough = classified > 0 && (minimum == null || classified >= minimum);
	return { classified, late, minimum, share: enough ? late / classified : null };
}

export function departureLateSentence(locale: Locale) {
	return choose(
		locale,
		'of the observed stop events of this departure were late.',
		'des passages observés de ce départ étaient en retard.',
	);
}

/** "2,310 observed stop events over 6 days. 3 of the 6 days had a late stop." */
export function departureLateDetail(answer: RecordSeries, locale: Locale) {
	const { classified } = departureLateShare(answer);
	const { late, observed } = departureDays(answer);
	if (!observed) return null;
	const events = tally(classified, locale);
	const days = tally(observed, locale);
	return choose(
		locale,
		`${events} observed stop events over ${countedUnit(observed, 'day', locale)}. ${tally(late, locale)} of the ${days} days had a late stop.`,
		`${events} passages observés sur ${countedUnit(observed, 'day', locale)}. Au moins un retard à un arrêt pendant ${tally(late, locale)} des ${days} jours.`,
	);
}

/** Cite text: "12.3% of the observed stop events of this departure were late. ..." */
export function departureLateStatement(answer: RecordSeries, locale: Locale) {
	const { share } = departureLateShare(answer);
	const detail = departureLateDetail(answer, locale);
	return [
		share == null ? null : `${recordPercent(share, locale)} ${departureLateSentence(locale)}`,
		detail,
	]
		.filter(Boolean)
		.join(' ');
}
