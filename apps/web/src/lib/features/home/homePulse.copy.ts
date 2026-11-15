import { defineCopy, type Locale } from '#lib/i18n/copy.ts';

type PulseKey =
	| 'recordTitle'
	| 'recordPeriod'
	| 'recordShare'
	| 'recordDefinition'
	| 'recordBasis'
	| 'recordUnits'
	| 'recordBefore'
	| 'recordThin'
	| 'recordUnpublished'
	| 'recordNone'
	| 'recordError'
	| 'openRecord'
	| 'reporting'
	| 'reportingOne'
	| 'silent'
	| 'silentOne'
	| 'silentNote'
	| 'silentNoteOne'
	| 'refresh'
	| 'liveUnavailable'
	| 'openMap'
	| 'rankTitle'
	| 'worstLines'
	| 'worstStops'
	| 'worstNote'
	| 'worstThrough'
	| 'worstUnavailable'
	| 'worstNotCurrent'
	| 'worstError'
	| 'unavailable'
	| 'lateRate'
	| 'allHotspots';

export const homePulseCopy = defineCopy({
	fr: {
		recordTitle: 'Dernier bilan complet',
		recordPeriod: 'Du {dates}, dernière semaine complète',
		recordShare: 'des relevés étaient à l’heure.',
		recordDefinition: 'À l’heure : d’une minute d’avance à 5 minutes de retard.',
		recordBasis: 'Selon {n} relevés.',
		recordUnits: 'Ce ne sont ni des trajets ni des passagers.',
		recordBefore: 'la semaine précédente, du {dates}.',
		recordThin: 'Pas assez de relevés pour établir une part : {n} cette semaine.',
		recordUnpublished: 'Aucune part de relevés à l’heure n’est publiée pour cette semaine.',
		recordNone: 'Aucune semaine complète n’est encore publiée.',
		recordError: 'Le bilan n’a pas pu être chargé.',
		openRecord: 'Ouvrir le bilan du réseau',
		reporting: 'véhicules se signalent',
		reportingOne: 'véhicule se signale',
		silent: 'trajets silencieux',
		silentOne: 'trajet silencieux',
		silentNote: 'Prévus en ce moment, mais aucun véhicule ne se signale.',
		silentNoteOne: 'Prévu en ce moment, mais aucun véhicule ne se signale.',
		refresh: 'Actualiser',
		liveUnavailable: 'Chiffres en direct indisponibles',
		openMap: 'Ouvrir la carte en direct',
		rankTitle: 'Lignes et arrêts à examiner',
		worstLines: 'Lignes les plus en retard',
		worstStops: 'Arrêts les plus en retard',
		worstNote:
			'Part des mesures en retard de plus de 5 min, sur 7 jours. Le bilan est republié chaque semaine.',
		worstThrough: 'Données jusqu’au {date}',
		worstUnavailable: 'Aucun classement hebdomadaire publié pour l’instant.',
		worstNotCurrent: 'Aucun classement hebdomadaire à jour n’est disponible.',
		worstError: 'Le classement n’a pas pu être chargé.',
		unavailable: 'indisponible',
		lateRate: '{pct} des mesures en retard de plus de 5 min',
		allHotspots: 'Tous les points chauds',
	},
	en: {
		recordTitle: 'Latest complete record',
		recordPeriod: '{dates}, latest complete week',
		recordShare: 'of readings were on time.',
		recordDefinition: 'On time: 1 minute early to 5 minutes late.',
		recordBasis: 'Based on {n} readings.',
		recordUnits: 'These are not trips or passengers.',
		recordBefore: 'the week before, {dates}.',
		recordThin: 'Not enough readings to state a share: {n} this week.',
		recordUnpublished: 'No on-time share is published for this week.',
		recordNone: 'No complete week is published yet.',
		recordError: 'The record could not be loaded.',
		openRecord: 'Open the network record',
		reporting: 'vehicles reporting',
		reportingOne: 'vehicle reporting',
		silent: 'silent trips',
		silentOne: 'silent trip',
		silentNote: 'Scheduled now, but no vehicle is reporting.',
		silentNoteOne: 'Scheduled now, but no vehicle is reporting.',
		refresh: 'Refresh',
		liveUnavailable: 'Live numbers unavailable',
		openMap: 'Open live map',
		rankTitle: 'Lines and stops to investigate',
		worstLines: 'Most delayed lines',
		worstStops: 'Most delayed stops',
		worstNote:
			'Share of readings more than 5 min late, over 7 days. The record is republished weekly.',
		worstThrough: 'Data through {date}',
		worstUnavailable: 'No weekly ranking has been published yet.',
		worstNotCurrent: 'No current weekly ranking is available.',
		worstError: 'The rankings could not be loaded.',
		unavailable: 'unavailable',
		lateRate: '{pct} of readings more than 5 min late',
		allHotspots: 'All hotspots',
	},
} satisfies Readonly<Record<Locale, Readonly<Record<PulseKey, string>>>>);

export type HomePulseCopy = (typeof homePulseCopy)[Locale];

type InviteKey = 'title' | 'body' | 'contribute' | 'code' | 'contact' | 'support';

export const homeInviteCopy = defineCopy({
	fr: {
		title: 'Aidez à étendre Transit',
		body: 'Transit est un projet à code source ouvert, et nous cherchons des contributeurs. Il fonctionne avec toute société de transport qui publie des données GTFS et GTFS-Realtime, et les villes mesurées aujourd’hui ne sont que les premières. Ajoutez votre ville, améliorez une mesure, corrigez un défaut ou aidez à l’hébergement.',
		contribute: 'Comment contribuer',
		code: 'Voir le code',
		contact: 'Écrivez-nous',
		support:
			'Transit est un projet indépendant et bénévole. L’aide à l’hébergement est ce qui permet d’accueillir d’autres villes.',
	},
	en: {
		title: 'Help extend Transit',
		body: 'Transit is open source, and we are looking for contributors. It works with any agency that publishes GTFS and GTFS-Realtime data, and the cities measured today are only the first. Add your city, improve a metric, fix something or help with hosting.',
		contribute: 'How to contribute',
		code: 'View the code',
		contact: 'Get in touch',
		support:
			'Transit is an independent, volunteer project. Hosting help is what lets more cities join.',
	},
} satisfies Readonly<Record<Locale, Readonly<Record<InviteKey, string>>>>);

export const homeSearchCopy = defineCopy({
	fr: { label: 'Cherchez votre ligne ou votre arrêt' },
	en: { label: 'Search for your line or stop' },
} satisfies Readonly<Record<Locale, Readonly<Record<'label', string>>>>);

export const HOME_INVITE_LINKS = {
	contact: { en: 'https://yesid.dev/contact', fr: 'https://yesid.dev/fr/contact' },
	contribute: 'https://github.com/yesid-dev/transit/blob/main/CONTRIBUTING.md',
	code: 'https://github.com/yesid-dev/transit',
} as const;
