import {
	citationAccessed,
	citationSourceSentence,
	citeDates,
	lowCoverageReason,
	methodEvidence,
	missDirection,
	registryUnitText,
	minuteReading,
	recordHours,
	recordPercent,
	rankingComparison,
	reportingGapLength,
	singularCount,
	type CitationSource,
} from '#lib/site/presenter.ts';
import { intl, type Locale } from '#lib/i18n/index.ts';
import type { EngineResult, RecordAnswer, RankingsRecord } from '#lib/server/engine.ts';
import { choose } from '../record/recordText.ts';
import { overviewCopy } from '../home/overviewRecord.copy.ts';
import { reporting, worseIsHigher, type RankingMeasure } from './rankingSelection.ts';

type Row = RankingsRecord['rows'][number];
type Excluded = RankingsRecord['excluded'][number];

// [extreme, ranked]: the first row holds the extreme value, or it ranks first by the
// cautious bound while a row with fewer events shows a more extreme value.
// Each says lowest, highest, longest or most for its measure, never "top-ranked".
const leadPhrases: Record<RankingMeasure, Record<Locale, [extreme: string, ranked: string]>> = {
	on_time: {
		en: ['is the lowest on-time share', 'is the on-time share ranked lowest'],
		fr: ['est la plus faible part à l’heure', 'est la part à l’heure classée la plus faible'],
	},
	late: {
		en: ['is the highest late share', 'is the late share ranked highest'],
		fr: ['est la plus forte part en retard', 'est la part en retard classée la plus forte'],
	},
	early: {
		en: ['is the highest early departure share', 'is the early departure share ranked highest'],
		fr: [
			'est la plus forte part de départs en avance',
			'est la part de départs en avance classée la plus forte',
		],
	},
	median_delay: {
		en: ['is the longest median delay', 'is the median delay ranked longest'],
		fr: ['est le retard médian le plus long', 'est le retard médian classé le plus long'],
	},
	excess_wait_time: {
		en: ['is the longest excess wait', 'is the excess wait ranked longest'],
		fr: [
			'est l’attente excédentaire la plus longue',
			'est l’attente excédentaire classée la plus longue',
		],
	},
	cancelled_trips: {
		en: ['is the highest cancelled trip share', 'is the cancelled trip share ranked highest'],
		fr: [
			'est la plus forte part de trajets annulés',
			'est la part de trajets annulés classée la plus forte',
		],
	},
	missing_trips: {
		en: ['is the highest missing trip share', 'is the missing trip share ranked highest'],
		fr: [
			'est la plus forte part de trajets manquants',
			'est la part de trajets manquants classée la plus forte',
		],
	},
	// The rate per 100 hours stays on How we measure; riders read it per hour.
	[reporting]: {
		en: [
			'times an hour it stopped reporting, the highest rate',
			'times an hour it stopped reporting, the rate ranked highest',
		],
		fr: [
			'interruptions des signalements par heure, le taux le plus élevé',
			'interruptions des signalements par heure, le taux classé le plus élevé',
		],
	},
};

export function rankingLead(
	data: Pick<RankingsRecord, 'rows' | 'ranked_count'>,
	entry: Row,
	measure: RankingMeasure,
	countText: string,
	locale: Locale,
) {
	const higher = worseIsHigher(measure);
	const extreme =
		data.rows.length === data.ranked_count &&
		data.rows.every((row) => (higher ? row.value <= entry.value : row.value >= entry.value));
	const among =
		data.ranked_count === 1
			? choose(locale, 'for', 'pour')
			: choose(locale, 'among the', 'parmi les');
	return `${leadPhrases[measure][locale][extreme ? 0 : 1]} ${among} ${countText}${choose(locale, ':', '\u00a0:')}`;
}

/**
 * Which way a ranked line or stop misses its on-time window: "early 72.0%, late 6.2%". Only the
 * on-time ranking needs it: its "worst" rows are often early, not late.
 */
export function rankingWay(row: Pick<Row, 'counts'>, measure: RankingMeasure, locale: Locale) {
	return measure === 'on_time' ? missDirection(row.counts, locale) : null;
}

/**
 * What follows the leader's name in the ranking headline: " (early 72.0%, late 6.2%)." or ".".
 * The space is part of the text: markup whitespace at the edge of a Svelte block is trimmed.
 */
export function rankingHeadlineEnd(way: string | null) {
	return way ? ` (${way}).` : '.';
}

/** The headline after its figure: "<lead> <leader> (<way>)." */
export function rankingHeadline(lead: string, leader: string, way: string | null) {
	return `${lead} ${leader}${rankingHeadlineEnd(way)}`;
}

const sampleUnits = {
	headways: { en: 'observed intervals', fr: 'intervalles observés' },
	events: { en: 'observed stop events', fr: 'passages observés aux arrêts' },
	trips: { en: 'eligible trips', fr: 'trajets admissibles' },
	hours: { en: 'hours in service', fr: 'heures en service' },
};

export const rankOptionLabels: Partial<Record<RankingMeasure, Record<Locale, string>>> = {
	early: { en: 'Early share', fr: 'Part en avance' },
	excess_wait_time: { en: 'Excess wait', fr: 'Attente' },
	cancelled_trips: { en: 'Cancelled share', fr: 'Part annulée' },
	missing_trips: { en: 'Missing share', fr: 'Part manquante' },
	[reporting]: { en: 'Stopped reporting', fr: 'Interruptions' },
};

function number(value: number, locale: Locale) {
	return intl.number(locale, { maximumFractionDigits: 2 }).format(value);
}

export function rankingValue(value: number, measure: RankingMeasure, locale: Locale) {
	if (measure === 'median_delay' || measure === 'excess_wait_time')
		return minuteReading(value / 60, locale)!;
	if (measure === reporting)
		return intl
			.number(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
			.format(value / 100);
	return recordPercent(value, locale);
}

export function rankingReference(
	result: EngineResult<RecordAnswer> | null,
	ranking: RankingsRecord,
	measure: RankingMeasure,
	locale: Locale,
) {
	if (
		result?.kind !== 'answer' ||
		!('value' in result.answer) ||
		result.answer.state !== 'measured'
	)
		return null;
	const reference = result.answer;
	const value = reference.value[measure];
	const methodVersion = reference.evidence.method_version;
	if (
		value == null ||
		methodVersion !== ranking.evidence.method_version ||
		(reference.evidence.measure_states?.[measure] ?? 'measured') !== 'measured'
	)
		return null;
	const title =
		ranking.kind === 'vehicle'
			? choose(locale, 'Fleet', 'Parc de véhicules')
			: choose(locale, 'Network', 'Réseau');
	return { value, methodVersion, label: `${title} (${rankingValue(value, measure, locale)})` };
}

export function rankingVerdict(
	row: Row,
	reference: ReturnType<typeof rankingReference>,
	method: string,
	measure: RankingMeasure,
	locale: Locale,
) {
	if (measure === reporting) return null;
	return rankingComparison(row.range, reference, method, worseIsHigher(measure), locale);
}

export function rankingRange({ range }: Row, measure: RankingMeasure, locale: Locale) {
	if (range.lower == null || range.upper == null) return choose(locale, 'Unknown', 'Inconnu');
	const low = rankingValue(range.lower, measure, locale);
	const high = rankingValue(range.upper, measure, locale);
	return choose(locale, `${low} to ${high}`, `${low} à ${high}`);
}

export function sampleText(sample: number, measure: RankingMeasure, locale: Locale) {
	const unit =
		measure === 'excess_wait_time'
			? 'headways'
			: measure === reporting
				? 'hours'
				: measure === 'cancelled_trips' || measure === 'missing_trips'
					? 'trips'
					: 'events';
	const formatted = unit === 'hours' ? recordHours(sample, locale) : number(sample, locale);
	return `${formatted} ${sampleUnits[unit][locale]}`;
}

export function rankingCountLines(row: Row, measure: RankingMeasure, locale: Locale) {
	const lines = [sampleText(row.sample, measure, locale)];
	const { observed_trips: trips, observed_trip_pairs: pairs, reporting_gaps: gaps } = row.counts;
	if (measure === reporting) {
		// "155 times in 21 hours": the count and the hours the rate comes from.
		if (gaps != null) {
			const hours = recordHours(row.sample, locale);
			const unit =
				Math.round(row.sample * 10) === 10
					? choose(locale, 'hour', 'heure')
					: choose(locale, 'hours', 'heures');
			const length = reportingGapLength(gaps, row.counts.silent_hours, locale);
			return [
				choose(
					locale,
					`${number(gaps, locale)} ${gaps === 1 ? 'time' : 'times'} in ${hours} ${unit}`,
					`${number(gaps, locale)} ${singularCount(gaps, locale) ? 'interruption' : 'interruptions'} en ${hours} ${unit}`,
				),
				...(length ? [length] : []),
			];
		}
	} else if (measure === 'excess_wait_time') {
		if (pairs != null)
			lines.push(
				choose(
					locale,
					`${number(pairs, locale)} trip pairs`,
					`${number(pairs, locale)} ${pairs < 2 ? 'paire de trajets' : 'paires de trajets'}`,
				),
			);
	} else if (trips != null && measure !== 'cancelled_trips' && measure !== 'missing_trips') {
		const unit = singularCount(trips, locale)
			? choose(locale, 'trip', 'trajet')
			: choose(locale, 'trips', 'trajets');
		lines.push(`${number(trips, locale)} ${unit}`);
	}
	return lines;
}

export function lineRankingFloor(
	measure: RankingMeasure,
	floors: Record<string, number> | undefined,
	locale: Locale,
) {
	if (measure === 'early' && floors?.classified != null && floors.observed_trips != null) {
		const events = number(floors.classified, locale);
		const trips = number(floors.observed_trips, locale);
		return choose(
			locale,
			`Each line needs at least ${events} observed stop events and ${trips} observed trips to rank.`,
			`Chaque ligne doit compter au moins ${events} passages observés aux arrêts et ${trips} trajets observés pour être classée.`,
		);
	}
	if (
		measure === 'excess_wait_time' &&
		floors?.observed_headways != null &&
		floors.observed_trip_pairs != null
	) {
		const intervals = number(floors.observed_headways, locale);
		const pairs = number(floors.observed_trip_pairs, locale);
		return choose(
			locale,
			`Each line needs at least ${intervals} observed intervals and ${pairs} distinct observed trip pairs to rank.`,
			`Chaque ligne doit compter au moins ${intervals} intervalles observés et ${pairs} paires distinctes de trajets observés pour être classée.`,
		);
	}
	return null;
}

export function exclusionText(row: Excluded, measure: RankingMeasure, locale: Locale) {
	if (row.reason === 'low_coverage') return lowCoverageReason(row, locale);
	const reason = row.reason_text[locale];
	return row.reason === 'too_few_to_judge' && row.sample != null
		? `${reason} · ${sampleText(row.sample, measure, locale)}`
		: reason;
}

/** The on-time window in the words every other screen uses. */
export function measureMeaning(measure: RankingMeasure, definition: string, locale: Locale) {
	return measure === 'on_time'
		? overviewCopy[locale].definition
		: registryUnitText(definition, locale);
}

/** "regular lines" (or "regular line") for a chosen class, for the ranked count; null otherwise. */
export function rankedNoun(
	kind: RankingsRecord['kind'],
	serviceClass: string | null,
	classes: string[],
	locale: Locale,
	count = 2,
) {
	if (kind !== 'line' || !serviceClass || serviceClass === 'all') return null;
	const plural = classText(serviceClass, locale, classes).toLocaleLowerCase(locale);
	if (count !== 1) return plural;
	return locale === 'fr'
		? plural.replace(/^lignes/u, 'ligne').replace(/(régulière|fréquente)s/u, '$1')
		: plural.replace(/ lines/u, ' line');
}

export function classText(key: string, locale: Locale, classes: string[] = []) {
	if (key === 'all') return choose(locale, 'All lines', 'Toutes les lignes');
	const [type, pattern] = key.split(':');
	const service =
		pattern === 'night'
			? choose(locale, 'Night lines', 'Lignes de nuit')
			: pattern === 'frequent'
				? choose(locale, 'Frequent lines', 'Lignes fréquentes')
				: choose(locale, 'Regular lines', 'Lignes régulières');
	// Ordinary lines carry no mode word; only a mode that tells something is named.
	if (type === '3') return service;
	if (!classes.some((other) => other !== key && other.split(':')[1] === pattern)) return service;
	const modes: Record<string, string> = {
		'0': choose(locale, 'tram', 'train léger'),
		'1': choose(locale, 'metro', 'métro'),
		'2': choose(locale, 'rail', 'train'),
		'3': choose(locale, 'road', 'route'),
		mixed: choose(locale, 'mixed modes', 'modes mixtes'),
		unknown: choose(locale, 'unknown mode', 'mode inconnu'),
	};
	const mode = modes[type] ?? choose(locale, `type ${type}`, `type ${type}`);
	return `${service} (${mode})`;
}

// Classification from LineSchedule.service_class in the engine.
export function serviceClassDefinition(key: string, locale: Locale) {
	if (key === 'all')
		return choose(
			locale,
			'Includes every service class.',
			'Comprend toutes les classes de service.',
		);
	switch (key.split(':')[1]) {
		case 'night':
			return choose(
				locale,
				'More than half of scheduled trips depart before 05:00 local time.',
				'Plus de la moitié des trajets prévus partent avant 5 h, heure locale.',
			);
		case 'frequent':
			return choose(
				locale,
				'The average scheduled interval from 07:00 to 09:00 local time is 10 minutes or less. The rule uses weekdays unless the selected dates are all on a weekend.',
				'L’intervalle moyen prévu de 7 h à 9 h, heure locale, est de 10 minutes ou moins. La règle s’applique aux jours de semaine, ou aux jours de fin de semaine si la période ne contient que ceux-ci.',
			);
		default:
			return choose(
				locale,
				'The line meets neither the night nor the frequent service rule.',
				'La ligne ne répond ni au critère de nuit ni à celui du service fréquent.',
			);
	}
}

export function rankingCitation(
	title: string,
	measure: string,
	city: string,
	answer: RankingsRecord,
	locale: Locale,
	href: string,
	lastGood?: true,
	source?: CitationSource | null,
	accessed: string = new Date().toISOString().slice(0, 10),
) {
	const { evidence } = answer;
	const dates = citeDates({ from: evidence.start_date, to: evidence.end_date }, locale);
	const days = number(evidence.days_measured.length, locale);
	const measured = choose(locale, `Days measured (${days}).`, `Jours mesurés (${days}).`);
	const service =
		answer.kind === 'line' && answer.class
			? `${answer.class === 'all' ? choose(locale, 'All service classes', 'Toutes les classes de service') : classText(answer.class, locale)}. `
			: '';
	const older = lastGood ? choose(locale, ' Older answer.', ' Calcul précédent.') : '';
	const cited = source
		? ` ${citationSourceSentence(source, locale)} ${citationAccessed(accessed, locale)}`
		: '';
	return `Transit · ${title} · ${measure} · ${city}. ${dates}. ${service}${measured} ${methodEvidence(evidence, locale)}${older}${cited} ${href}`;
}
