import { dateRange, methodEvidence } from '#lib/site/presenter.ts';
import { intl, type Locale } from '#lib/i18n/index.ts';
import type { EngineResult, MeasureAnswer } from '#lib/server/engine.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';

import {
	rateStateText,
	withCoverage,
	percent,
	recordConnection,
	tally,
} from '../record/recordText.ts';
import { comparePeriods, periodDays } from './periodComparison.ts';
import { recordState, type RecordState } from '../record/recordStates';
export { dateRange, percent, tally };

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

	const share = percent(value, locale);
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
	return `${withCoverage(reading, answer.evidence, locale)}.`;
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

	const points = intl
		.number(locale, {
			signDisplay: 'exceptZero',
			minimumFractionDigits: 1,
			maximumFractionDigits: 2,
		})
		.format(change.points);
	const magnitude = Math.abs(Math.round(change.points * 100) / 100);
	const delta =
		locale === 'fr'
			? `${points} ${magnitude < 2 ? 'point' : 'points'} de pourcentage`
			: `${points} percentage ${magnitude === 1 ? 'point' : 'points'}`;
	if (change.direction === 'same')
		return locale === 'fr'
			? `Environ pareil (variation normale) [${delta}]`
			: `About the same (within normal variation) [${delta}]`;
	return locale === 'fr' ? `Écart de ${delta}.` : `Change of ${delta}.`;
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
	const state: RecordState =
		result.kind === 'answer' && result.answer.state !== 'measured'
			? result.answer.state
			: 'not_measured';
	return { state, sentence: recordState(state)[locale] };
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
