import {
	countedUnit,
	dateRange,
	methodEvidence,
	recordPercent,
	sampleWithMinimum,
	singularCount,
} from '#lib/site/presenter.ts';
import { intl, type Locale } from '#lib/i18n/index.ts';
import type { EngineResult, MeasureAnswer, RankingAnswer } from '#lib/server/engine.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';

import { rateStateText, coverageText, recordConnection, tally } from '../record/recordText.ts';
import { comparePeriods, periodDays } from './periodComparison.ts';
import { recordState, type RecordState } from '../record/recordStates';
export { dateRange, tally };

export { previousPeriod } from './periodComparison.ts';

export interface OverviewPunctuality {
	period: DateWindow;
	punctuality: Promise<EngineResult<MeasureAnswer>>;
}

export function measureText(
	result: EngineResult<MeasureAnswer>,
	period: DateWindow,
	locale: Locale,
): string {
	if (result.kind !== 'answer') return recordConnection[result.kind][locale];
	const answer = result.answer;
	if (answer.state !== 'measured') return rateStateText(answer, locale);

	const value = answer.value[answer.measure === 'trips_run' ? 'trips_run' : 'on_time'];
	const { on_time, classified, ran, eligible } = answer.evidence.counts;
	const punctuality = answer.measure !== 'trips_run';
	const [top, bottom] = punctuality ? [on_time, classified] : [ran, eligible];
	if (value == null || top == null || bottom == null || bottom === 0)
		return recordConnection.unreachable[locale];

	const share = recordPercent(value, locale);
	const dates = dateRange(period, locale);
	const n = tally(top, locale);
	const total = tally(bottom, locale);
	const reading = punctuality
		? locale === 'fr'
			? `${dates}, ${share} des passages observés aux arrêts étaient à l’heure (${n} sur ${total})`
			: `${dates}, ${share} of observed stop events were on time (${n} of ${total})`
		: locale === 'fr'
			? `${dates}, ${share} des trajets prévus dont le résultat est connu ont été effectués (${n} sur ${total})`
			: `${dates}, ${share} of scheduled trips with a known outcome ran (${n} of ${total})`;
	return `${[reading, coverageText(answer.evidence, locale)].filter(Boolean).join(' · ')}.`;
}

export function comparisonText(
	current: EngineResult<MeasureAnswer>,
	previous: EngineResult<MeasureAnswer>,
	locale: Locale,
): string | null {
	if (current.kind !== 'answer' || previous.kind !== 'answer') return null;
	if (current.answer.state !== 'measured' || previous.answer.state !== 'measured') return null;
	const now = comparisonSample(current.answer);
	const then = comparisonSample(previous.answer);
	if (!now || !then) return null;
	const change = comparePeriods(now, then);
	if (!change) return null;

	const magnitude = Math.round(Math.abs(change.points) * 10) / 10;
	const points = intl
		.number(locale, {
			minimumFractionDigits: 1,
			maximumFractionDigits: 1,
		})
		.format(magnitude);
	if (magnitude === 0)
		return locale === 'fr'
			? 'Environ pareil (variation normale)'
			: 'About the same (within normal variation)';
	const higher = change.points > 0;
	const point = singularCount(magnitude, locale) ? 'point' : 'points';
	const difference =
		locale === 'fr'
			? `${points} ${point} de ${higher ? 'plus' : 'moins'}`
			: `${points} ${point} ${higher ? 'higher' : 'lower'}`;
	if (change.direction !== 'same') return difference;
	return `${difference} (${locale === 'fr' ? 'variation normale' : 'within normal variation'})`;
}

function comparisonSample({ evidence, value }: MeasureAnswer) {
	const { counts, share_observed, days_measured, start_date, end_date } = evidence;
	if (
		value.on_time == null ||
		counts.on_time == null ||
		counts.classified == null ||
		share_observed == null
	)
		return null;
	return {
		onTime: counts.on_time,
		observed: counts.classified,
		measuredDays: days_measured.length,
		days: periodDays(start_date, end_date),
		observedShare: share_observed,
	};
}

export function citationText(answer: MeasureAnswer, period: DateWindow, locale: Locale): string {
	const reading = measureText({ kind: 'answer', answer }, period, locale);
	return `${reading} ${methodEvidence(answer.evidence, locale)}`;
}

export function overviewValue(result: EngineResult<MeasureAnswer>, measure: string) {
	return result.kind === 'answer' && result.answer.state === 'measured'
		? (result.answer.value[measure] ?? null)
		: null;
}

export function overviewState(result: EngineResult<MeasureAnswer>, locale: Locale) {
	if (result.kind !== 'answer') return { sentence: recordConnection[result.kind][locale] };
	const { answer } = result;
	const state = answer.state === 'measured' ? 'not_measured' : answer.state;
	const isTrips = answer.measure === 'trips_run';
	const count = answer.evidence.counts[isTrips ? 'eligible' : 'classified'];
	const minimum = (
		answer.info?.find(({ id }) => id === (isTrips ? 'trips_run' : 'on_time')) ?? answer.info?.[0]
	)?.minimum_sample;
	return {
		state,
		sentence: recordState(state)[locale],
		detail:
			state === 'too_few_to_judge' && count != null
				? sampleDetails([count], isTrips ? 'trip' : 'event', minimum, locale)
				: undefined,
	};
}

function sampleDetails(
	samples: readonly number[],
	unit: 'event' | 'trip',
	minimum: number | undefined,
	locale: Locale,
) {
	if (!samples.length) return undefined;
	const low = Math.min(...samples);
	const high = Math.max(...samples);
	const sample =
		low === high
			? countedUnit(high, unit, locale)
			: `${tally(low, locale)}–${countedUnit(high, unit, locale)}`;
	return minimum == null ? sample : sampleWithMinimum(sample, minimum, locale);
}

export function rankingState(answer: RankingAnswer, locale: Locale) {
	const reasons = new Set(answer.excluded.map(({ reason }) => reason));
	const state: RecordState =
		reasons.size > 1
			? 'unknown'
			: answer.state && answer.state !== 'measured'
				? answer.state
				: answer.excluded[0]?.reason && answer.excluded[0].reason !== 'measured'
					? answer.excluded[0].reason
					: answer.evidence.days_included.length
						? 'unknown'
						: 'not_measured';
	const metadata = answer.info[0];
	const floors = metadata.ranking_floors?.[answer.kind];
	const details =
		state === 'too_few_to_judge'
			? [
					sampleDetails(
						answer.excluded.flatMap(({ sample }) => (sample == null ? [] : [sample])),
						'event',
						floors?.classified ?? metadata.ranking_minimum_sample ?? metadata.minimum_sample,
						locale,
					),
					floors?.observed_trips == null
						? undefined
						: sampleDetails(
								answer.excluded.flatMap(({ counts }) =>
									counts?.observed_trips == null ? [] : [counts.observed_trips],
								),
								'trip',
								floors.observed_trips,
								locale,
							),
				]
					.filter(Boolean)
					.join(' · ')
			: undefined;
	return { state, detail: details };
}

export function recordCounts(
	events: number | null | undefined,
	trips: number | null | undefined,
	days: string,
	locale: Locale,
) {
	if (events == null && trips == null) return null;
	return [
		events == null ? null : countedUnit(events, 'event', locale),
		trips == null ? null : countedUnit(trips, 'trip', locale),
		days,
	]
		.filter(Boolean)
		.join(', ');
}

export function lateLines(vehicles: readonly { route?: string | null; status: string }[]) {
	const counts = new Map<string, { id: string; late: number; total: number }>();
	for (const vehicle of vehicles) {
		if (!vehicle.route) continue;
		const row = counts.get(vehicle.route) ?? { id: vehicle.route, late: 0, total: 0 };
		row.total++;
		if (vehicle.status === 'late') row.late++;
		counts.set(vehicle.route, row);
	}
	return [...counts.values()]
		.filter((line) => line.late > 0)
		.sort((a, b) => b.late - a.late || a.id.localeCompare(b.id))
		.slice(0, 3);
}
