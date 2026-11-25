import { defineCopy } from '#lib/i18n/copy.ts';
import type { Locale } from '#lib/i18n/config.ts';

type RoadmapState = 'planned' | 'in-progress' | 'done';

interface RoadmapEntry {
	readonly id: string;
	readonly state: RoadmapState;
	readonly title: Readonly<Record<Locale, string>>;
	readonly description: Readonly<Record<Locale, string>>;
}

export const roadmapTitle = {
	en: 'Roadmap',
	fr: 'Feuille de route',
} satisfies Readonly<Record<Locale, string>>;

export const roadmapCopy = defineCopy({
	en: {
		heading: 'What is changing in Transit',
		introduction:
			'Thank you for all the feedback. We read every message. It showed that fixing pages one at a time would not give you what you asked for, so Transit is being rebuilt as an app. While the new version is built, this site gets no new features.',
		currentHeading: 'What stays the same meanwhile',
		current: [
			'This site keeps running, and its data keeps updating every day.',
			'Real problems are still fixed.',
			'The new version replaces this one only when it is complete.',
		],
		entriesHeading: 'Entries',
		entriesIntroduction:
			'No dates are promised. Each item below is named by what it will let you do.',
		contributeHeading: 'Follow or contribute',
		follow: {
			before: 'Transit is open source. Follow the work or suggest an idea on ',
			repository: 'GitHub',
			between: ', or write to us through the ',
			contact: 'contact link',
			after: '.',
		},
		states: {
			planned: 'Planned',
			'in-progress': 'In progress',
			done: 'Done',
		},
	},
	fr: {
		heading: 'Ce qui change dans Transit',
		introduction:
			"Merci pour tous vos commentaires. Nous les avons tous lus. Ils ont montré qu'en corrigeant les pages une à une, nous n'arriverions pas à vous offrir ce que vous demandiez. Transit est donc reconstruit sous forme d'application. Pendant la construction de la nouvelle version, ce site ne reçoit pas de nouvelles fonctions.",
		currentHeading: "Ce qui ne change pas d'ici là",
		current: [
			"Ce site reste en ligne et ses données continuent d'être mises à jour chaque jour.",
			'Les vrais problèmes sont toujours corrigés.',
			"La nouvelle version ne remplacera celle-ci que lorsqu'elle sera complète.",
		],
		entriesHeading: 'Éléments',
		entriesIntroduction:
			"Aucune date n'est promise. Chaque élément ci-dessous est nommé selon ce qu'il vous permettra de faire.",
		contributeHeading: 'Suivre ou contribuer',
		follow: {
			before: 'Transit est un logiciel libre. Suivez le travail ou proposez une idée sur ',
			repository: 'GitHub',
			between: ', ou écrivez-nous par le ',
			contact: 'lien de contact',
			after: '.',
		},
		states: {
			planned: 'Prévu',
			'in-progress': 'En cours',
			done: 'Terminé',
		},
	},
});

export const ROADMAP_ENTRIES: readonly RoadmapEntry[] = [
	{
		id: 'transit-app',
		state: 'in-progress',
		title: {
			en: 'Transit becomes an app.',
			fr: 'Transit devient une application.',
		},
		description: {
			en: "One app to read your city's transit: how the network is running right now, and how it ran on any dates the record covers, from one day to a full year.",
			fr: "Une seule application pour suivre le transport collectif de votre ville : comment le réseau roule en ce moment, et comment il a roulé aux dates de votre choix couvertes par l'historique, d'une journée à une année complète.",
		},
	},
	{
		id: 'measure-definitions',
		state: 'planned',
		title: {
			en: 'One definition for every number.',
			fr: 'Une seule définition pour chaque chiffre.',
		},
		description: {
			en: 'Every number shows the counts behind it. Each measure has one definition, the same on every page and in every download. When data is missing, the page says so instead of showing a zero.',
			fr: "Chaque chiffre montre les décomptes sur lesquels il repose. Chaque mesure a une seule définition, la même sur toutes les pages et dans tous les téléchargements. Quand des données manquent, la page le dit au lieu d'afficher un zéro.",
		},
	},
	{
		id: 'date-ranges',
		state: 'planned',
		title: {
			en: 'Any dates you choose.',
			fr: 'Les dates de votre choix.',
		},
		description: {
			en: 'Pick yesterday, the last week, a month, or your own dates. The record starts in October 2026 and grows every day.',
			fr: "Choisissez hier, la dernière semaine, un mois ou vos propres dates. L'historique commence en octobre 2026 et s'allonge chaque jour.",
		},
	},
	{
		id: 'vehicles',
		state: 'planned',
		title: {
			en: 'Vehicles.',
			fr: 'Véhicules.',
		},
		description: {
			en: 'Find a vehicle by its number: where it is now, which line and trip it is running, and its days in service.',
			fr: "Trouvez un véhicule par son numéro : où il se trouve maintenant, la ligne et le trajet qu'il assure, et ses jours en service.",
		},
	},
	{
		id: 'rankings',
		state: 'planned',
		title: {
			en: 'Rankings for any dates.',
			fr: 'Classements pour toutes les dates.',
		},
		description: {
			en: 'The lines, stops, departures and vehicles that do worst over the dates you choose, with how many observations each result rests on.',
			fr: "Les lignes, arrêts, départs et véhicules les moins fiables aux dates choisies, avec le nombre d'observations sur lequel repose chaque résultat.",
		},
	},
	{
		id: 'map-history',
		state: 'planned',
		title: {
			en: 'The record on the map.',
			fr: "L'historique sur la carte.",
		},
		description: {
			en: 'Map layers that show where delays build up: stops coloured by how often vehicles are late there, and the stretches between stops where time is lost.',
			fr: "Des couches de carte qui montrent où les retards s'accumulent : les arrêts colorés selon la fréquence des retards, et les tronçons entre deux arrêts où le temps se perd.",
		},
	},
	{
		id: 'data-downloads',
		state: 'planned',
		title: {
			en: 'Download the data.',
			fr: 'Télécharger les données.',
		},
		description: {
			en: "The cleaned records themselves, by city and by day, with their layout explained and each agency's licence stated, once each licence allows it.",
			fr: 'Les données nettoyées elles-mêmes, par ville et par jour, avec leur structure expliquée et la licence de chaque société de transport indiquée, dès que chaque licence le permet.',
		},
	},
	{
		id: 'new-cities',
		state: 'planned',
		title: {
			en: 'Any city that publishes its data.',
			fr: 'Toute ville qui publie ses données.',
		},
		description: {
			en: 'Any transit agency that publishes its schedule and live data in the standard open formats (GTFS and GTFS-Realtime) can be added.',
			fr: 'Toute société de transport qui publie ses horaires et ses données en temps réel dans les formats ouverts standards (GTFS et GTFS-Realtime) pourra être ajoutée.',
		},
	},
];

export const roadmapLinks = {
	contact: { en: 'https://yesid.dev/contact', fr: 'https://yesid.dev/fr/contact' },
	code: 'https://github.com/yesid-dev/transit',
} as const;
