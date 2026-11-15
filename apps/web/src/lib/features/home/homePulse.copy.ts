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
	| 'rankMeasure'
	| 'rankOrder'
	| 'rankPeriod'
	| 'rankReadings'
	| 'worstUnavailable'
	| 'worstNotCurrent'
	| 'worstError'
	| 'unavailable'
	| 'lateRate'
	| 'openRankings';

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
		worstLines: 'Lignes',
		worstStops: 'Arrêts',
		rankMeasure: 'Part des relevés en retard de plus de 5 minutes.',
		rankOrder:
			'Classés selon la part affichée, de la plus élevée à la plus faible. Des positions voisines ne montrent pas forcément une différence nette.',
		rankPeriod: 'Du {dates}, {n} jours complets',
		rankReadings: '{n} relevés',
		worstUnavailable: 'Aucun classement hebdomadaire publié pour l’instant.',
		worstNotCurrent: 'Aucun classement hebdomadaire à jour n’est disponible.',
		worstError: 'Le classement n’a pas pu être chargé.',
		unavailable: 'indisponible',
		lateRate: '{pct} des relevés en retard de plus de 5 minutes',
		openRankings: 'Ouvrir les classements complets',
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
		worstLines: 'Lines',
		worstStops: 'Stops',
		rankMeasure: 'Share of readings more than 5 minutes late.',
		rankOrder:
			'Ordered by the share shown, highest first. Nearby positions do not necessarily show a clear difference.',
		rankPeriod: '{dates}, {n} complete days',
		rankReadings: '{n} readings',
		worstUnavailable: 'No weekly ranking has been published yet.',
		worstNotCurrent: 'No current weekly ranking is available.',
		worstError: 'The rankings could not be loaded.',
		unavailable: 'unavailable',
		lateRate: '{pct} of readings more than 5 minutes late',
		openRankings: 'Open the full rankings',
	},
} satisfies Readonly<Record<Locale, Readonly<Record<PulseKey, string>>>>);

export type HomePulseCopy = (typeof homePulseCopy)[Locale];

type InviteKey = 'title' | 'body' | 'contribute' | 'code' | 'contact';

export const homeInviteCopy = defineCopy({
	fr: {
		title: 'Aidez à étendre Transit',
		body: 'Transit est un projet à code source ouvert, et nous cherchons des contributeurs. Il fonctionne avec toute société de transport qui publie des données GTFS et GTFS-Realtime, et les villes mesurées aujourd’hui ne sont que les premières.',
		contribute: 'Comment contribuer',
		code: 'Voir le code',
		contact: 'Écrivez-nous',
	},
	en: {
		title: 'Help extend Transit',
		body: 'Transit is open source, and we are looking for contributors. It works with any agency that publishes GTFS and GTFS-Realtime data, and the cities measured today are only the first.',
		contribute: 'How to contribute',
		code: 'View the code',
		contact: 'Get in touch',
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
