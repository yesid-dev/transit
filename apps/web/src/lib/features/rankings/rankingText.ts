import { intl, type Locale } from '#lib/i18n/index.ts';
import type { RankingsRecord } from '#lib/server/engine.ts';
import { choose, dateRange, methodEvidence, percent, withCoverage } from '../record/recordText.ts';
import { reporting, type RankingMeasure } from './rankingSelection.ts';

type Row = RankingsRecord['rows'][number];
type Excluded = RankingsRecord['excluded'][number];

const sampleUnits = {
	headways: { en: 'observed intervals', fr: 'intervalles observés' },
	events: { en: 'observed stop events', fr: 'passages observés' },
	trips: { en: 'eligible trips', fr: 'trajets admissibles' },
	hours: { en: 'hours in service', fr: 'heures en service' },
};

const numerators: Partial<Record<RankingMeasure, string>> = {
	on_time: 'on_time',
	early: 'early',
	late: 'late',
	cancelled_trips: 'cancelled',
	missing_trips: 'missing',
	[reporting]: 'reporting_gaps',
};

function number(value: number, locale: Locale) {
	return intl.number(locale, { maximumFractionDigits: 2 }).format(value);
}

export function rankingValue(value: number, measure: RankingMeasure, locale: Locale) {
	if (measure === 'median_delay' || measure === 'excess_wait_time')
		return `${number(value, locale)} s`;
	if (measure === reporting)
		return `${number(value, locale)} ${choose(locale, 'per 100 h', 'par 100 h')}`;
	return percent(value, locale);
}

export function rankingRange({ range }: Row, measure: RankingMeasure, locale: Locale) {
	if (range.lower == null || range.upper == null) return choose(locale, 'Unknown', 'Inconnu');
	const low = rankingValue(range.lower, measure, locale);
	const high = rankingValue(range.upper, measure, locale);
	return choose(locale, `${low} to ${high}`, `${low} à ${high}`);
}

export function rankingRangeLabel(method: string, locale: Locale) {
	return method === 'histogram_half_bin'
		? choose(locale, 'Bin rounding only', 'Arrondi des classes seulement')
		: choose(locale, 'Range', 'Intervalle');
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
	return `${number(sample, locale)} ${sampleUnits[unit][locale]}`;
}

export function rankingSample(row: Row, measure: RankingMeasure, locale: Locale) {
	const key = numerators[measure];
	const count = key ? row.counts[key] : null;
	const sample = sampleText(row.sample, measure, locale);
	if (count == null) return withCoverage(sample, row, locale);
	const n = number(count, locale);
	return withCoverage(choose(locale, `${n} in ${sample}`, `${n} sur ${sample}`), row, locale);
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
			`Chaque ligne doit compter au moins ${events} passages observés et ${trips} trajets observés pour être classée.`,
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

export function waitingRankingBasis(counts: Row['counts'], locale: Locale) {
	const { observed_trip_pairs: pairs, covered_scheduled_headways: matched } = counts;
	if (pairs == null || matched == null) return '';
	return choose(
		locale,
		`${number(pairs, locale)} distinct observed trip pairs, ${number(matched, locale)} scheduled intervals in comparable windows.`,
		`${number(pairs, locale)} paires distinctes de trajets observés, ${number(matched, locale)} intervalles prévus dans des fenêtres comparables.`,
	);
}

export function exclusionText(row: Excluded, measure: RankingMeasure, locale: Locale) {
	const reason = row.reason_text[locale];
	return row.reason === 'too_few_to_judge' && row.sample != null
		? `${reason} · ${sampleText(row.sample, measure, locale)}`
		: reason;
}

export function classText(key: string, locale: Locale) {
	const [type, pattern] = key.split(':');
	const service =
		pattern === 'night'
			? choose(locale, 'Night service', 'Service de nuit')
			: pattern === 'frequent'
				? choose(locale, 'Frequent service', 'Service fréquent')
				: choose(locale, 'Regular service', 'Service régulier');
	const mode =
		type === 'unknown'
			? choose(locale, 'unknown mode', 'mode inconnu')
			: type === 'mixed'
				? choose(locale, 'mixed modes', 'modes mixtes')
				: choose(locale, `GTFS type ${type}`, `type GTFS ${type}`);
	return `${service} (${mode})`;
}

export function rankingCitation(
	title: string,
	measure: string,
	city: string,
	answer: RankingsRecord,
	locale: Locale,
	href: string,
	lastGood?: true,
) {
	const { evidence } = answer;
	const dates = dateRange({ from: evidence.start_date, to: evidence.end_date }, locale);
	const days = number(evidence.days_measured.length, locale);
	const measured = choose(locale, `Days measured (${days}).`, `Jours mesurés (${days}).`);
	const service =
		answer.kind === 'line' && answer.class
			? `${answer.class === 'all' ? choose(locale, 'All service classes', 'Toutes les classes de service') : classText(answer.class, locale)}. `
			: '';
	const older = lastGood ? choose(locale, ' Older answer.', ' Calcul précédent.') : '';
	return `Transit · ${title} · ${measure} · ${city}. ${dates}. ${service}${measured} ${methodEvidence(evidence, locale)}${older} ${href}`;
}
