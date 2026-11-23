import { intl, type Locale } from '#lib/i18n/index.ts';
import type {
	EngineResult,
	RankingsRecord,
	RecordAnswer,
	RecordCell,
	RecordEvidence,
} from '#lib/server/engine.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';

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

export const recordConnection = {
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
	busy: {
		en: 'The record is busy right now. You can come back later.',
		fr: 'Le bilan est très sollicité en ce moment. Vous pouvez revenir plus tard.',
	},
};

export const lastGoodNote = {
	en: 'This is an older answer. The latest answer is temporarily unavailable.',
	fr: 'Ce résultat provient d’un calcul précédent. Le résultat le plus récent est temporairement indisponible.',
};

export function methodEvidence(
	evidence: Pick<RecordEvidence, 'method_version' | 'cleaning_versions'>,
	locale: Locale,
): string {
	const { method_version, cleaning_versions } = evidence;
	const versions = cleaning_versions.join(', ');
	if (locale === 'fr') {
		return `Méthode ${method_version}. ${
			versions
				? `Nettoyage des données, version ${versions}.`
				: 'Version du nettoyage des données inconnue.'
		}`;
	}
	return `Method ${method_version}. ${
		versions ? `Data cleaning version ${versions}.` : 'Data cleaning version unknown.'
	}`;
}

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
	const rate = percent(share, locale);
	return scheduled == null
		? choose(locale, `${rate} of scheduled stops observed`, `${rate} des passages prévus observés`)
		: choose(
				locale,
				`${rate} of ${tally(scheduled, locale)} scheduled stops observed`,
				`${rate} des ${tally(scheduled, locale)} passages prévus observés`,
			);
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
	if (share_observed != null && counts?.frequent_headways != null) {
		const rate = percent(share_observed, locale);
		const total = tally(counts.frequent_headways, locale);
		coverage = choose(
			locale,
			`${rate} coverage of ${total} scheduled intervals in frequent periods`,
			`Couverture de ${rate} sur ${total} intervalles prévus en période fréquente`,
		);
	}
	if (share_eligible != null) {
		const rate = percent(share_eligible, locale);
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
		const rate = percent(share_occupancy_readings, locale);
		const sample = tally(counts.occupancy_readings, locale);
		const total = tally(counts.readings, locale);
		coverage = choose(
			locale,
			`Occupancy reported in ${rate} of readings (${sample} of ${total})`,
			`Achalandage signalé dans ${rate} des relevés (${sample} sur ${total})`,
		);
	}
	return [coverage, low_coverage ? choose(locale, 'Low coverage', 'Faible couverture') : '']
		.filter(Boolean)
		.join(' · ');
}

export function periodCoverage(
	evidence: Pick<RecordEvidence, 'start_date' | 'end_date' | 'days_included'>,
	locale: Locale,
) {
	const days = tally(
		(Date.parse(evidence.end_date) - Date.parse(evidence.start_date)) / 86_400_000 + 1,
		locale,
	);
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
		const reason = choose(locale, 'insufficient coverage', 'couverture insuffisante');
		return withCoverage(`${status} (${reason})`, answer.evidence, locale);
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
		['trip_update_reported', 'time reported by the agency', 'heure signalée par l’agence'],
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
		read(key) ? [`${percent(read(key) / total, locale)} ${choose(locale, en, fr)}`] : [],
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
	fr: 'Le classement des parts utilise la borne prudente de l’intervalle à 95 %. La part affichée est le taux exact observé.',
};

export function emptyRecord(evidence: RecordEvidence, locale: Locale) {
	return evidence.days_included.length
		? choose(locale, 'Unknown', 'Inconnu')
		: choose(locale, 'Not measured', 'Non mesuré');
}

export function punctualityBands(cell: RecordCell, locale: Locale) {
	const data = [
		['early', choose(locale, 'Early', 'En avance')],
		['on_time', choose(locale, 'On time', 'À l’heure')],
		['late', choose(locale, 'Late', 'En retard')],
	] as const;
	return data.map(([id, label]) => ({ id, label, reading: shareReading(cell, id, locale, false) }));
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
		`${percent(share, locale)} (${tally(n, locale)}/${tally(total, locale)})`,
		cell.evidence,
		locale,
	);
	const basis = includeBasis ? timingBasis(cell.evidence.counts, locale) : '';
	return basis ? `${reading}. ${basis}` : reading;
}
