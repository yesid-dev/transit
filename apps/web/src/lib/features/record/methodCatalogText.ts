import type { Locale } from '#lib/i18n/index.ts';
import type { MethodEntry } from '#lib/server/engine.ts';
import { registryUnitText } from '#lib/site/presenter.ts';
import methodNames from './methodNames.json';

// These display names belong in the engine registry when it supplies localized titles.
const names: Readonly<Partial<Record<string, readonly string[]>>> = methodNames;

const featured = [
	{
		id: 'on_time',
		name: methodNames.on_time,
		has: (id: string) => id === 'on_time',
	},
	{
		id: 'early-late',
		name: ['Early and late', 'En avance et en retard'],
		summary: [
			'Early is more than 1 minute ahead of the timetable. Late is more than 5 minutes behind it.',
			'Un passage est en avance s’il a lieu plus de 1 minute avant l’heure prévue. Il est en retard s’il a lieu plus de 5 minutes après.',
		],
		has: (id: string) => id === 'early' || id === 'late',
	},
	{
		id: 'trip-delivery',
		name: ['Trips that ran, cancelled and missing', 'Trajets effectués, annulés et manquants'],
		summary: [
			'A scheduled trip ran, was cancelled with a notice from the agency, or is missing: no vehicle was seen and no notice was found.',
			'Un trajet prévu a été effectué, a été annulé avec un avis de l’agence ou est manquant : aucun véhicule n’a été observé et aucun avis n’a été relevé.',
		],
		has: (id: string) => ['trips_run', 'cancelled_trips', 'missing_trips'].includes(id),
	},
	{
		id: 'delay-percentiles',
		name: ['Median delay and 90th percentile', 'Retard médian et 90e percentile'],
		summary: [
			'About half of observed stop events were at or below the median delay. About nine in ten were at or below the 90th percentile.',
			'Environ la moitié des passages observés avaient un retard inférieur ou égal à la médiane. Environ neuf sur dix avaient un retard inférieur ou égal au 90e percentile.',
		],
		has: (id: string) => id === 'median_delay' || id === 'p90_delay',
	},
	{
		id: 'vehicle-measures',
		name: [
			'Vehicles: in service, stopped reporting, trips not finished',
			'Véhicules : en service, sans signal et trajets inachevés',
		],
		summary: [
			'A vehicle is in service on a day when it reported at least once while on a scheduled trip.',
			'Un véhicule est en service s’il a transmis au moins un relevé pendant un trajet prévu ce jour-là.',
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
	const index = locale === 'en' ? 0 : 1;
	const list = new Intl.ListFormat(locale);
	const groups = featured.flatMap(({ id, name, summary, has }) => {
		const matching = entries.filter((entry) => has(entry.id));
		return matching.length
			? [{ id, name: name[index], summary: summary?.[index], entries: matching }]
			: [];
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
		summary: list.format(members.map((entry) => methodName(entry, locale))) + '.',
		entries: members,
	}));
	return { groups, extra };
}

export function methodName(entry: MethodEntry, locale: Locale) {
	return (
		names[entry.id]?.[locale === 'en' ? 0 : 1] ?? methodSummary(entry, locale).replace(/\.$/u, '')
	);
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
