import { intl, type Locale } from '#lib/i18n/index.ts';
import type { MethodEntry } from '#lib/server/engine.ts';
import { registryUnitText } from '#lib/site/presenter.ts';

const names: Record<string, readonly [string, string]> = {
	on_time: ['On-time share', 'Part à l’heure'],
	early: ['Early share', 'Part en avance'],
	late: ['Late share', 'Part en retard'],
	median_delay: ['Median delay', 'Retard médian'],
	p90_delay: ['90th percentile delay', '90e percentile du retard'],
	trips_run: ['Trips that ran', 'Trajets effectués'],
	cancelled_trips: ['Cancelled trips', 'Trajets annulés'],
	missing_trips: ['Missing trips', 'Trajets manquants'],
	service_hours: ['Service hours delivered', 'Heures de service effectuées'],
	first_trip: ['First departure', 'Premier départ'],
	last_trip: ['Last departure', 'Dernier départ'],
	crowding_empty: ['Empty vehicles', 'Véhicules vides'],
	crowding_many_seats: ['Many seats available', 'Plusieurs places assises libres'],
	crowding_few_seats: ['Few seats available', 'Peu de places assises libres'],
	crowding_standing: ['Standing room only', 'Places debout seulement'],
	crowding_crushed: ['Limited standing room', 'Peu de places debout'],
	crowding_full: ['Full vehicles', 'Véhicules pleins'],
	alerts: ['Active alerts', 'Avis en vigueur'],
	alert_versions: ['Alert versions', 'Versions des avis'],
	alert_hours: ['Hours with alerts', 'Heures avec avis'],
	observed_headway: ['Observed interval', 'Intervalle observé'],
	scheduled_headway: ['Scheduled interval', 'Intervalle prévu'],
	bunching: ['Vehicles following too closely', 'Véhicules trop rapprochés'],
	long_gaps: ['Long gaps', 'Longs intervalles'],
	excess_wait_time: ['Excess wait', 'Attente supplémentaire'],
	scheduled_trips: ['Scheduled trips', 'Trajets prévus'],
	scheduled_frequency: ['Scheduled frequency', 'Fréquence prévue'],
	below_minimum_service: ['Periods below minimum service', 'Périodes sous le seuil de service'],
	vehicle_days_in_service: ['Days in service', 'Jours en service'],
	vehicle_hours_in_service: ['Hours in service', 'Heures en service'],
	vehicle_lines_run: ['Lines served', 'Lignes desservies'],
	vehicle_trips_run: ['Trips served', 'Trajets réalisés'],
	vehicle_reporting_gaps: ['Reporting gaps', 'Interruptions du signal'],
	vehicle_silent_hours: ['Time without a signal', 'Durée sans signal'],
	vehicle_reporting_gaps_per_100_hours: [
		'Reporting gaps per 100 hours',
		'Interruptions par 100 heures',
	],
	vehicle_unfinished_trips: ['Unfinished trips', 'Trajets inachevés'],
	vehicle_unfinished_trips_per_100_trips: [
		'Unfinished trips per 100 trips',
		'Trajets inachevés par 100 trajets',
	],
	vehicle_early: ['Early share by vehicle', 'Part en avance par véhicule'],
	vehicle_on_time: ['On-time share by vehicle', 'Part à l’heure par véhicule'],
	vehicle_late: ['Late share by vehicle', 'Part en retard par véhicule'],
	vehicle_median_delay: ['Median delay by vehicle', 'Retard médian par véhicule'],
	vehicle_p90_delay: ['90th percentile delay by vehicle', '90e percentile du retard par véhicule'],
	median_time_lost: ['Median time lost', 'Temps perdu médian'],
	p90_time_lost: ['90th percentile time lost', '90e percentile du temps perdu'],
	mean_time_lost: ['Mean time lost', 'Temps perdu moyen'],
	total_vehicle_minutes_lost: ['Total vehicle-minutes lost', 'Total des minutes-véhicules perdues'],
	poll_success: ['Successful captures', 'Collectes réussies'],
	feed_update_interval: ['Time between feed updates', 'Intervalle entre les mises à jour du flux'],
	feed_age_at_capture: ['Age of the feed at capture', 'Âge du flux à la collecte'],
	vehicle_field_completeness: [
		'Completeness of vehicle reports',
		'Données présentes dans les relevés de véhicules',
	],
	live_trip_coverage: ['Realtime trip coverage', 'Couverture des trajets en temps réel'],
	vehicles_without_trip: ['Vehicles without a trip', 'Véhicules sans trajet associé'],
	prediction_error: ['Prediction error', 'Erreur de prévision'],
	accessible_trips: ['Accessible trips', 'Trajets accessibles'],
	accessible_stops: ['Accessible stops', 'Arrêts accessibles'],
};

const featured = [
	{ id: 'on_time', name: names.on_time, has: (id: string) => id === 'on_time' },
	{
		id: 'early-late',
		name: ['Early and late', 'En avance et en retard'],
		has: (id: string) => id === 'early' || id === 'late',
	},
	{
		id: 'trip-delivery',
		name: ['Trips that ran, cancelled and missing', 'Trajets effectués, annulés et manquants'],
		has: (id: string) => ['trips_run', 'cancelled_trips', 'missing_trips'].includes(id),
	},
	{
		id: 'delay-percentiles',
		name: ['Median delay and 90th percentile', 'Retard médian et 90e percentile'],
		has: (id: string) => id === 'median_delay' || id === 'p90_delay',
	},
	{
		id: 'vehicle-measures',
		name: [
			'Vehicles: in service, stopped reporting, trips not finished',
			'Véhicules : en service, sans signal et trajets inachevés',
		],
		has: (id: string) =>
			id.startsWith('vehicle_') &&
			![
				'vehicle_early',
				'vehicle_on_time',
				'vehicle_late',
				'vehicle_median_delay',
				'vehicle_p90_delay',
				'vehicle_field_completeness',
			].includes(id),
	},
];

export function methodGroups(entries: MethodEntry[], locale: Locale) {
	const groups = featured.flatMap(({ id, name, has }) => {
		const matching = entries.filter((entry) => has(entry.id));
		return matching.length ? [{ id, name: name[locale === 'en' ? 0 : 1], entries: matching }] : [];
	});
	const used = new Set(groups.flatMap((group) => group.entries.map((entry) => entry.id)));
	const extra = Object.entries(
		Object.groupBy(
			entries.filter(({ id }) => !used.has(id)),
			({ family }) => family,
		),
	).map(([id, members = []]) => ({
		id: 'family-' + id,
		name: members[0].family_text?.[locale] ?? id,
		entries: members,
	}));
	return { groups, extra };
}

export function methodName(entry: MethodEntry, locale: Locale) {
	return (
		names[entry.id]?.[locale === 'en' ? 0 : 1] ?? methodSummary(entry, locale).replace(/\.$/u, '')
	);
}

export function methodDate(day: string, locale: Locale) {
	return intl.dateTime(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(day));
}

const proseFields = ['counts', 'exclusions', 'limits'] as const;

function sentences(text: string, locale: Locale) {
	return Array.from(
		new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(text),
		({ segment }) => segment.trim(),
	).filter(Boolean);
}

export function methodSummary(entry: MethodEntry, locale: Locale) {
	return registryUnitText(sentences(entry.text[locale].definition, locale)[0] ?? '', locale);
}

/** Own each repeated sentence on its first card in the family and keep it reachable from dependent cards. */
export function methodParts(entries: MethodEntry[], locale: Locale) {
	const first = new Map<string, string>();
	return Object.fromEntries(
		entries.map((entry) => {
			const source = entry.text[locale];
			const parts = proseFields.map((field) => {
				const text =
					field === 'counts'
						? [source.counts, source.histogram].filter(Boolean).join(' ')
						: source[field];
				const unique: string[] = [];
				const shared = new Set<string>();
				for (const sentence of sentences(registryUnitText(text, locale), locale)) {
					const key = JSON.stringify([entry.family, field, sentence]);
					const owner = first.get(key);
					if (owner && owner !== entry.id) shared.add(owner);
					else if (!owner) {
						first.set(key, entry.id);
						unique.push(sentence);
					}
				}
				const [lead, ...notes] = unique;
				return { field, lead, notes: notes.join(' '), shared: [...shared] };
			});
			const definition = sentences(source.definition, locale).slice(1).join(' ');
			return [entry.id, { parts, definition: registryUnitText(definition, locale) }] as const;
		}),
	);
}
