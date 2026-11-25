import { recordPercent as percent } from '#lib/site/presenter.ts';
import { minuteReading } from '#lib/site/presenter.ts';
import { intl, type Locale } from '#lib/i18n/index.ts';
import { healthReading } from '#lib/features/record/dataHealthText.ts';
import { choose, tally } from '#lib/features/record/recordText.ts';
import type { ScorecardAnswer } from '#lib/server/engine.ts';

import type { NetworkMeasure } from './networkMeasures.ts';
export { networkMeasures, type NetworkMeasure } from './networkMeasures.ts';

const feeds = {
	trip_updates: ['Trip updates', 'Mises à jour des trajets'],
	vehicle_positions: ['Vehicle positions', 'Positions des véhicules'],
	alerts: ['Service alerts', 'Avis de service'],
} satisfies Record<string, [string, string]>;

const fields = {
	trip: ['Trip', 'Trajet'],
	route: ['Line', 'Ligne'],
	stop: ['Stop', 'Arrêt'],
	current_status: ['Current status', 'Statut actuel'],
	occupancy: ['Occupancy', 'Occupation'],
	position: ['Position', 'Position'],
} satisfies Record<string, [string, string]>;

const states = {
	not_measured: ['Not measured', 'Non mesuré'],
	too_few_to_judge: ['Too few to judge', 'Trop peu de données pour conclure'],
	no_live_data: ['No live data', 'Aucune donnée en direct'],
	not_tracked: ['Not tracked', 'Non suivi'],
	not_published: ['Not tracked (field not published)', 'Non suivi (champ non publié)'],
	unknown: ['Unknown', 'Inconnu'],
} satisfies Record<string, [string, string]>;

function object(value: unknown): Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function networkRows(measure: NetworkMeasure, answer: ScorecardAnswer, locale: Locale) {
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const stateText = (state: keyof typeof states) => t(...states[state]);
	const values = object(answer.value[measure]);
	const counts = answer.evidence.counts[measure] ?? {};
	const dimensions = answer.evidence.dimension_states[measure] ?? {};
	const noMeasuredDays =
		!answer.evidence.days_measured.length && answer.evidence.days_not_measured.length > 0;
	const missing = (key: string) => {
		const state = dimensions[key] ?? answer.state;
		if (state === 'measured') return t('Unknown', 'Inconnu');
		return stateText(noMeasuredDays && state === 'unknown' ? 'not_measured' : state);
	};
	const formatNumber = intl.number(locale, { maximumFractionDigits: 1 });
	const ratio = (n: unknown, total: unknown) =>
		typeof n === 'number' && typeof total === 'number' && total > 0
			? `${tally(n, locale)} / ${tally(total, locale)}`
			: '';
	const samples = (n: unknown) => (typeof n === 'number' && n > 0 ? tally(n, locale) : '');
	const duration = (value: unknown, signed = false) =>
		value === 'over_10_minutes'
			? t('Over 10 min', 'Plus de 10 min')
			: (minuteReading(typeof value === 'number' ? value / 60 : null, locale, signed) ??
				t('Unknown', 'Inconnu'));
	const hours = (value: number) => formatNumber.format(value / 3_600_000_000);

	if (measure === 'poll_success') {
		return {
			headers: [
				t('Feed', 'Flux'),
				t('Successful checks', 'Vérifications réussies'),
				t('Successes / attempts', 'Réussites / tentatives'),
			],
			rows: Object.entries(feeds).map(([feed, label]) => {
				const value = values[feed];
				const { attempts, successful } = object(counts[feed]);
				const reading =
					dimensions[feed] === 'measured' && typeof value === 'number'
						? percent(value, locale)
						: !Object.hasOwn(values, feed) && !noMeasuredDays
							? stateText('not_tracked')
							: missing(feed);
				return [t(...label), reading, ratio(successful, attempts)];
			}),
		};
	}
	if (measure === 'feed_age_at_capture' || measure === 'feed_update_interval') {
		return {
			headers: [
				t('Feed', 'Flux'),
				t('Median', 'Médiane'),
				t('90th percentile', '90e centile'),
				t('Samples', 'Observations'),
			],
			rows: Object.entries(feeds).map(([feed, label]) => {
				const { median_seconds, p90_seconds } = object(values[feed]);
				const sample = object(counts[feed]);
				const noTimestamp =
					typeof sample.successful === 'number' &&
					sample.successful > 0 &&
					sample.timestamped_successes === 0;
				const reading =
					!Object.hasOwn(values, feed) && !noMeasuredDays
						? stateText('not_tracked')
						: noTimestamp
							? t(
									'Not tracked (no publication timestamp)',
									'Non suivi (aucun horodatage de publication)',
								)
							: missing(feed);
				const measured = dimensions[feed] === 'measured';
				return [
					t(...label),
					measured ? duration(median_seconds) : reading,
					measured ? duration(p90_seconds) : reading,
					samples(sample.samples),
				];
			}),
		};
	}
	if (measure === 'live_trip_coverage') {
		const value = answer.value[measure];
		const { appeared, eligible, never_seen, scheduled, never_seen_share } = counts;
		return {
			headers: [
				t('Trips', 'Trajets'),
				t('Share', 'Part'),
				t('Trips counted / total', 'Trajets comptés / total'),
			],
			rows: [
				[
					t('Seen on lines with live data', 'Vus sur les lignes avec des données en direct'),
					answer.state === 'measured' && typeof value === 'number'
						? percent(value, locale)
						: missing(measure),
					ratio(appeared, eligible),
				],
				[
					t(
						'Scheduled on lines never seen in live data',
						'Prévus sur les lignes jamais vues en direct',
					),
					typeof never_seen_share === 'number' && !noMeasuredDays
						? percent(never_seen_share, locale)
						: missing(measure),
					!noMeasuredDays ? ratio(never_seen, scheduled) : '',
				],
			],
		};
	}
	if (measure === 'vehicle_field_completeness') {
		return {
			headers: [
				t('Field', 'Champ'),
				t('Share of reporting time', 'Part du temps de signalement'),
				t('Hours with field / total hours', 'Heures avec le champ / heures totales'),
			],
			rows: Object.entries(fields).map(([field, label]) => {
				const value = values[field];
				const { present_us, reporting_us } = object(counts[field]);
				const measured = dimensions[field] === 'measured' && typeof value === 'number';
				return [
					t(...label),
					measured ? percent(value, locale) : missing(field),
					measured && typeof present_us === 'number' && typeof reporting_us === 'number'
						? `${hours(present_us)} / ${hours(reporting_us)}`
						: '',
				];
			}),
		};
	}
	return {
		headers: [
			t('Lead time', 'Temps d’avance'),
			t('Median signed error', 'Erreur médiane signée'),
			t('90th percentile absolute error', '90e centile de l’erreur absolue'),
			t('Within one minute', 'À une minute près'),
			t('Observed arrivals', 'Arrivées observées'),
		],
		rows: Object.entries(values).map(([horizon, value]) => {
			const data = object(value);
			const measured = dimensions[horizon] === 'measured';
			const within = data.within_60_seconds_share;
			return [
				`${horizon} min`,
				measured ? duration(data.median_signed_seconds, true) : missing(horizon),
				measured ? duration(data.p90_absolute_seconds) : missing(horizon),
				measured && typeof within === 'number' ? percent(within, locale) : missing(horizon),
				samples(data.sample_count),
			];
		}),
	};
}

export function networkUnmeasuredDays(
	measure: NetworkMeasure,
	answer: ScorecardAnswer,
	locale: Locale,
) {
	const { days_not_measured, days_not_measured_reasons, capture_gap_days } = answer.evidence;
	const gaps = new Set(capture_gap_days[measure]);
	const date = intl.dateTime(locale, { dateStyle: 'medium', timeZone: 'UTC' });
	return days_not_measured.map((day) => [
		date.format(new Date(day)),
		gaps.has(day)
			? choose(locale, 'Capture interrupted', 'Collecte interrompue')
			: healthReading(
					{ status: 'not_measured', reason: days_not_measured_reasons[day] ?? 'unknown' },
					locale,
				),
	]);
}
