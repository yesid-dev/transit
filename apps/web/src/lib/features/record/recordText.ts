import { intl, type Locale } from '#lib/i18n/index.ts';
import { countedUnit, recordPercent } from '#lib/site/presenter.ts';
import type {
	EngineResult,
	RankingsRecord,
	RecordAnswer,
	RecordCell,
	RecordEvidence,
} from '#lib/server/engine.ts';

export function tally(value: number, locale: Locale): string {
	return intl.number(locale, { maximumFractionDigits: 0 }).format(value);
}

const temporarilyUnavailable = {
	en: 'The record is temporarily unavailable.',
	fr: 'Le bilan est temporairement indisponible.',
};

export const recordConnection = {
	unconfigured: {
		en: 'The record is not available.',
		fr: 'Le bilan n’est pas disponible.',
	},
	unreachable: temporarilyUnavailable,
	timeout: temporarilyUnavailable,
	busy: {
		en: 'The record is busy right now.',
		fr: 'Le bilan est très sollicité en ce moment.',
	},
};

export const lastGoodNote = {
	en: 'This is an older answer. The latest answer is temporarily unavailable.',
	fr: 'Ce résultat provient d’un calcul précédent. Le résultat le plus récent est temporairement indisponible.',
};

export const notMeasuredLabel = { en: 'Not measured', fr: 'Non mesuré' };
export const lowCoverageLabel = { en: 'Low coverage', fr: 'Faible couverture' };

export function choose(locale: Locale, en: string, fr: string) {
	return locale === 'fr' ? fr : en;
}

type Counts = RecordCell['evidence']['counts'];
type RateEvidence = Omit<RecordCell['evidence'], 'days_included' | 'counts'> & { counts?: Counts };

export function observedCoverage(
	share: number | null | undefined,
	scheduled: number | null | undefined,
	locale: Locale,
) {
	if (share == null) return '';
	const rate = recordPercent(share, locale);
	return scheduled == null
		? choose(locale, `${rate} of scheduled stops observed`, `${rate} des passages prévus observés`)
		: choose(
				locale,
				`${rate} of ${tally(scheduled, locale)} scheduled stops observed`,
				`${rate} des ${tally(scheduled, locale)} passages prévus observés`,
			);
}

export function lowCoverageText(locale: Locale) {
	return lowCoverageLabel[locale];
}

export function coverageText(evidence: RateEvidence, locale: Locale) {
	const {
		counts,
		excluded,
		share_observed,
		share_eligible,
		share_occupancy_readings,
		low_coverage,
	} = evidence;
	let coverage = observedCoverage(
		share_observed,
		counts?.scheduled ?? counts?.punctuality_scheduled,
		locale,
	);
	if (counts?.frequent_headways != null) {
		const matched = counts.covered_scheduled_headways;
		const planned = counts.frequent_headways;
		coverage = '';
		if (matched != null && planned > 0 && matched <= planned) {
			const rate = recordPercent(matched / planned, locale);
			const sample = tally(matched, locale);
			const total = tally(planned, locale);
			coverage = choose(
				locale,
				`Measured on ${sample} of the ${total} gaps planned when vehicles are due every 10 minutes or less (${rate})`,
				`Mesuré sur ${sample} des ${total} intervalles prévus quand les véhicules passent aux 10 minutes ou moins (${rate})`,
			);
		}
	}
	if (share_eligible != null) {
		const rate = recordPercent(share_eligible, locale);
		const scheduled = counts?.scheduled;
		const withLive =
			scheduled == null ? null : scheduled - (excluded?.route_without_live_data ?? 0);
		const trips = withLive == null ? '' : `${tally(withLive, locale)} `;
		coverage = choose(
			locale,
			`Status known for ${rate} of ${trips}scheduled trips on lines with live data`,
			`État connu pour ${rate} des ${trips}trajets prévus sur les lignes avec données en direct`,
		);
	}
	if (
		share_occupancy_readings != null &&
		counts?.occupancy_readings != null &&
		counts.readings != null
	) {
		const rate = recordPercent(share_occupancy_readings, locale);
		const sample = tally(counts.occupancy_readings, locale);
		const total = tally(counts.readings, locale);
		coverage = choose(
			locale,
			`Occupancy reported in ${rate} of readings (${sample} of ${total})`,
			`Occupation signalée dans ${rate} des relevés (${sample} sur ${total})`,
		);
	}
	return [coverage, low_coverage ? lowCoverageLabel[locale] : ''].filter(Boolean).join(' · ');
}

type EvidenceDays = Pick<RecordEvidence, 'start_date' | 'end_date' | 'days_included'>;

function selectedDays(evidence: EvidenceDays) {
	return (Date.parse(evidence.end_date) - Date.parse(evidence.start_date)) / 86_400_000 + 1;
}

export function countedRecordDays(evidence: EvidenceDays, locale: Locale) {
	const included = evidence.days_included.length;
	if (!included) return '';
	const days = selectedDays(evidence);
	if (included < days) {
		return choose(
			locale,
			`${tally(included, locale)} of the ${tally(days, locale)} days`,
			`${tally(included, locale)} des ${tally(days, locale)} jours`,
		);
	}
	return countedUnit(included, 'day', locale);
}

export function periodCoverage(evidence: EvidenceDays, locale: Locale) {
	const days = tally(selectedDays(evidence), locale);
	const included = tally(evidence.days_included.length, locale);
	return choose(
		locale,
		`${included} of ${days} selected days included`,
		`Jours inclus (${included} sur ${days})`,
	);
}

export function withCoverage(reading: string, evidence: RateEvidence, locale: Locale) {
	const coverage = coverageText(evidence, locale);
	return [reading, coverage].filter(Boolean).join(' · ');
}

export function rateStateText(
	answer: Pick<RecordCell, 'state' | 'state_text'> & { evidence: RateEvidence },
	locale: Locale,
) {
	const status = answer.state_text[locale];
	if (
		answer.state === 'not_measured' &&
		answer.evidence.coverage_reason === 'insufficient_coverage'
	) {
		// Under the minimum the figure is not measured at all; "Low coverage" is only for a figure
		// measured under the warning limit, so it is not said twice.
		const reason = choose(locale, ': too little observed', '\u00a0: trop peu observé');
		return withCoverage(`${status}${reason}`, { ...answer.evidence, low_coverage: false }, locale);
	}
	return answer.evidence.low_coverage ? withCoverage(status, answer.evidence, locale) : status;
}

export const punctualityWeighting = {
	en: 'Long trips and frequent lines weigh more because we count stop events, open feeds do not report ridership, and lines without live data are outside the rate.',
	fr: 'Les longs trajets et les lignes fréquentes pèsent davantage parce que nous comptons les passages aux arrêts, les flux ouverts ne donnent pas le nombre de passagers et les lignes sans données en direct sont exclues du taux.',
};

export const pooledDays = {
	en: 'Figures over several days pool events, so busy weekdays weigh more.',
	fr: 'Les chiffres sur plusieurs jours regroupent les passages, donc les jours de semaine chargés pèsent davantage.',
};

export function timingBasis(counts: Counts | undefined, locale: Locale) {
	if (!counts) return '';
	const bases = [
		['vehicle_stopped', 'vehicle reported stopped', 'véhicule signalé à l’arrêt'],
		['vehicle_nearby', 'vehicle GPS near the stop', 'GPS du véhicule près de l’arrêt'],
		[
			'trip_update_reported',
			'time reported by the agency',
			'heure signalée par la société de transport',
		],
		[
			'trip_update_passed',
			'last prediction before the vehicle passed',
			'dernière prévision avant le passage du véhicule',
		],
	] as const;
	const read = (key: string) => counts[key] ?? counts[`punctuality_${key}`] ?? 0;
	const total = bases.reduce((sum, [key]) => sum + read(key), 0);
	if (!total) return '';
	const parts = bases.flatMap(([key, en, fr]) =>
		read(key) ? [`${recordPercent(read(key) / total, locale)} ${choose(locale, en, fr)}`] : [],
	);
	const caution =
		read('trip_update_passed') > total / 2
			? choose(
					locale,
					' Most times come from predictions.',
					' La plupart de ces heures proviennent de prévisions.',
				)
			: '';
	return (
		choose(locale, 'Observed times: ', 'Heures observées : ') + parts.join(', ') + '.' + caution
	);
}

export function recordMessage(
	result: EngineResult<RecordAnswer | RankingsRecord>,
	locale: Locale,
): string | null {
	if (result.kind !== 'answer') return recordConnection[result.kind][locale];
	const answer = result.answer;
	if ('rows' in answer) {
		if (answer.rows.length) return null;
		if (
			answer.kind === 'departure' &&
			answer.excluded.some((row) => row.reason === 'too_few_to_judge')
		) {
			const floors = answer.info[0]?.ranking_floors?.departure;
			if (floors) return departureRankingFloor(floors, locale, true);
		}
		if (answer.state_text) return answer.state_text[locale];
		const first = answer.excluded[0];
		if (first && answer.excluded.every((entry) => entry.reason === first.reason))
			return first.reason_text[locale];
	}
	if ('cells' in answer && answer.cells.length) return null;
	if ('cells' in answer && answer.state_text) return answer.state_text[locale];
	if ('value' in answer) return answer.state === 'measured' ? null : rateStateText(answer, locale);
	return emptyRecord(answer.evidence, locale);
}

export function departureRankingFloor(
	{ observed_service_dates, classified }: { observed_service_dates: number; classified: number },
	locale: Locale,
	empty = false,
) {
	const dates = tally(observed_service_dates, locale);
	const stops = tally(classified, locale);
	const floor = choose(
		locale,
		`Each departure needs at least ${dates} observed service dates and ${stops} observed stop events to rank.`,
		`Chaque départ doit compter au moins ${dates} dates de service observées et ${stops} passages observés pour être classé.`,
	);
	return empty
		? `${choose(locale, 'No departures qualified.', 'Aucun départ ne répond aux critères.')} ${floor}`
		: floor;
}

export const cautiousRanking = {
	en: 'Share rankings use the cautious end of the 95% range. The displayed share is the exact observed rate.',
	fr: 'Le classement des parts utilise la borne prudente de l’intervalle à 95\u00a0%. La part affichée est le taux exact observé.',
};

export function emptyRecord(evidence: RecordEvidence, locale: Locale) {
	return evidence.days_included.length
		? choose(locale, 'Unknown', 'Inconnu')
		: notMeasuredLabel[locale];
}

export function punctualityBands(cell: RecordCell, locale: Locale) {
	const data = [
		['early', choose(locale, 'Early', 'En avance')],
		['on_time', choose(locale, 'On time', 'À l’heure')],
		['late', choose(locale, 'Late', 'En retard')],
	] as const;
	return data.map(([id, label]) => ({ id, label, reading: shareReading(cell, id, locale, false) }));
}

export function measuredShare(cell: RecordCell | undefined, id: string): number | null {
	if (
		cell?.state !== 'measured' ||
		cell.evidence.counts[id] == null ||
		!cell.evidence.counts.classified
	)
		return null;
	return cell.value[id] ?? null;
}

export function shareReading(
	cell: Pick<RecordCell, 'state' | 'state_text' | 'value'> & {
		evidence: RateEvidence & { counts: Counts };
	},
	id: string,
	locale: Locale,
	includeBasis = true,
): string {
	if (cell.state !== 'measured') return rateStateText(cell, locale);
	const share = cell.value[id];
	const n = cell.evidence.counts[id];
	const total = cell.evidence.counts.classified;
	if (share == null || n == null || !total) return choose(locale, 'Unknown', 'Inconnu');
	const reading = withCoverage(
		`${recordPercent(share, locale)} (${tally(n, locale)}/${tally(total, locale)})`,
		cell.evidence,
		locale,
	);
	const basis = includeBasis ? timingBasis(cell.evidence.counts, locale) : '';
	return basis ? `${reading}. ${basis}` : reading;
}
