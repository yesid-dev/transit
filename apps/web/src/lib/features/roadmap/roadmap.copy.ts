import { defineCopy } from '#lib/i18n/copy.ts';
import type { Locale } from '#lib/i18n/config.ts';

export type RoadmapState = 'done' | 'in-progress' | 'next';

/** The screens an entry links to, by their menu key; the page resolves labels and paths. */
export type RoadmapScreen =
	| 'overview'
	| 'map'
	| 'network'
	| 'alerts'
	| 'lines'
	| 'stops'
	| 'vehicles'
	| 'search'
	| 'hotspots'
	| 'repeatOffenders'
	| 'receipt'
	| 'metrics'
	| 'status'
	| 'download';

interface RoadmapEntry {
	readonly id: string;
	readonly state: RoadmapState;
	readonly title: Readonly<Record<Locale, string>>;
	readonly description: Readonly<Record<Locale, string>>;
	readonly screens?: readonly RoadmapScreen[];
}

export const roadmapTitle = {
	en: 'Roadmap',
	fr: 'Feuille de route',
} satisfies Readonly<Record<Locale, string>>;

export const ROADMAP_STATES: readonly RoadmapState[] = ['done', 'in-progress', 'next'];

export const roadmapCopy = defineCopy({
	en: {
		introduction:
			'What Transit does today, what is being built and what comes next. No dates are promised.',
		states: {
			done: 'Available now',
			'in-progress': 'In progress',
			next: 'Next',
		},
		screensLabel: 'Open',
		contributeHeading: 'Follow or contribute',
		follow: {
			before: 'Transit is open source. Follow the work or suggest an idea on ',
			repository: 'GitHub',
			between: ', or write to us through the ',
			contact: 'contact link',
			after: '.',
		},
	},
	fr: {
		introduction:
			'Ce que Transit fait aujourd’hui, ce qui est en cours et ce qui suit. Aucune date n’est promise.',
		states: {
			done: 'Disponible maintenant',
			'in-progress': 'En cours',
			next: 'À venir',
		},
		screensLabel: 'Ouvrir',
		contributeHeading: 'Suivre ou contribuer',
		follow: {
			before: 'Transit est un logiciel libre. Suivez le travail ou proposez une idée sur ',
			repository: 'GitHub',
			between: ', ou écrivez-nous par le ',
			contact: 'lien de contact',
			after: '.',
		},
	},
});

export const ROADMAP_ENTRIES: readonly RoadmapEntry[] = [
	{
		id: 'right-now',
		state: 'done',
		title: {
			en: 'The network right now.',
			fr: 'Le réseau en ce moment.',
		},
		description: {
			en: 'Where each vehicle is, how late it runs and the agency’s notices, as its live feed reports them.',
			fr: 'Où se trouve chaque véhicule, son retard et les avis de service de la société de transport, tels que son flux en temps réel les donne.',
		},
		screens: ['overview', 'map', 'network', 'alerts'],
	},
	{
		id: 'record',
		state: 'done',
		title: {
			en: 'Every line, stop and vehicle, on the dates you choose.',
			fr: 'Chaque ligne, chaque arrêt et chaque véhicule, aux dates de votre choix.',
		},
		description: {
			en: 'How each one ran over one day or up to a full year of the record, and what it is doing now. The record grows every day.',
			fr: 'Comment chacun a roulé, d’une journée à une année complète du bilan, et ce qu’il fait maintenant. Le bilan s’allonge chaque jour.',
		},
		screens: ['lines', 'stops', 'vehicles', 'search'],
	},
	{
		id: 'rankings',
		state: 'done',
		title: {
			en: 'Rankings and a daily report.',
			fr: 'Des classements et un rapport quotidien.',
		},
		description: {
			en: 'The lines, stops, trips and vehicles that do worst over the dates you choose, each with the count it rests on, and a report you can print or cite.',
			fr: 'Les lignes, arrêts, trajets et véhicules les moins fiables aux dates choisies, chacun avec le décompte sur lequel il repose, et un rapport à imprimer ou à citer.',
		},
		screens: ['hotspots', 'repeatOffenders', 'receipt'],
	},
	{
		id: 'open-data',
		state: 'done',
		title: {
			en: 'Open about its own numbers.',
			fr: 'Transparent sur ses propres chiffres.',
		},
		description: {
			en: 'One definition for every number, how complete the agency’s data is each day, and the cleaned files themselves under the agency’s licence.',
			fr: 'Une seule définition pour chaque chiffre, l’état des données de la société de transport chaque jour, et les fichiers nettoyés eux-mêmes, sous la licence de la société de transport.',
		},
		screens: ['metrics', 'status', 'download'],
	},
	{
		id: 'gatineau',
		state: 'in-progress',
		title: {
			en: 'Gatineau.',
			fr: 'Gatineau.',
		},
		description: {
			en: 'Transit already collects the STO’s data. Gatineau opens here once its record has been checked.',
			fr: 'Transit recueille déjà les données de la STO. Gatineau s’ajoutera ici une fois son bilan vérifié.',
		},
	},
	{
		id: 'new-cities',
		state: 'next',
		title: {
			en: 'More cities.',
			fr: 'D’autres villes.',
		},
		description: {
			en: 'Any transit agency that publishes its timetable and live data in the standard open formats (GTFS and GTFS-Realtime) can be added.',
			fr: 'Toute société de transport qui publie ses horaires et ses données en temps réel dans les formats ouverts standards (GTFS et GTFS-Realtime) pourra être ajoutée.',
		},
	},
];

export const roadmapLinks = {
	contact: { en: 'https://yesid.dev/contact', fr: 'https://yesid.dev/fr/contact' },
	code: 'https://github.com/yesid-dev/transit',
} as const;
