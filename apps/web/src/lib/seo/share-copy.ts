// Static invitations remain true when feeds are stale or unavailable.
import type { Locale } from '../i18n/config';
export const SHARE_COPY = {
	'/': {
		en: {
			support: 'An independent public record of transit service delivered',
			cta: 'Explore the network',
		},
		fr: {
			support: 'Un bilan public et indépendant du service réellement offert',
			cta: 'Explorer le réseau',
		},
	},
	'/map': {
		en: {
			support: 'Reported vehicle positions and transit stops',
			cta: 'View the map',
		},
		fr: {
			support: 'Positions signalées des véhicules et arrêts',
			cta: 'Voir la carte',
		},
	},
	'/lines': {
		en: {
			support: 'How on time each line ran and how much of its service was delivered',
			cta: 'Browse lines',
		},
		fr: {
			support: 'La ponctualité de chaque ligne et ses trajets effectués',
			cta: 'Voir les lignes',
		},
	},
	'/stops': {
		en: {
			support: 'How on time vehicles were at each stop, day by day',
			cta: 'Find a stop',
		},
		fr: {
			support: 'La ponctualité des passages à chaque arrêt, jour par jour',
			cta: 'Trouver un arrêt',
		},
	},
	'/network': {
		en: {
			support: 'How on time the network ran and how much of its service was delivered',
			cta: 'View network health',
		},
		fr: {
			support: 'La ponctualité du réseau et les trajets effectués',
			cta: 'Voir la santé du réseau',
		},
	},
	'/search': {
		en: {
			support: 'Find the record of a line, a stop or a vehicle',
			cta: 'Search Transit',
		},
		fr: {
			support: 'Trouver le bilan d’une ligne, d’un arrêt ou d’un véhicule',
			cta: 'Chercher dans Transit',
		},
	},
	'/metrics': {
		en: {
			support: 'What each measure counts, leaves out and cannot tell',
			cta: 'See how we measure',
		},
		fr: {
			support: 'Ce que chaque mesure compte, exclut et ne peut pas dire',
			cta: 'Voir comment on mesure',
		},
	},
	'/metrics/archive': {
		en: {
			support: 'Definitions and sources from the first Transit site through November 2026',
			cta: 'Read the archive',
		},
		fr: {
			support: 'Définitions et sources du premier site Transit, jusqu’en novembre 2026',
			cta: 'Lire les archives',
		},
	},
	'/download': {
		en: {
			support: 'Daily source files behind the figures, under the transit agency’s licence',
			cta: 'Download the data',
		},
		fr: {
			support:
				'Les fichiers quotidiens à la source des chiffres, sous la licence de la société de transport',
			cta: 'Télécharger les données',
		},
	},
	'/status': {
		en: {
			support: 'Feed age, sources and known data gaps',
			cta: 'Check data health',
		},
		fr: {
			support: 'Âge des données, sources et lacunes connues',
			cta: 'Voir la santé des données',
		},
	},
	'/rankings': {
		en: {
			support: 'Service rankings for lines, stops, departures and vehicles',
			cta: 'View the rankings',
		},
		fr: {
			support: 'Classement du service par ligne, arrêt, départ et véhicule',
			cta: 'Consulter le classement',
		},
	},
	'/receipt': {
		en: {
			support: 'One day of service: how on time it ran and how much was delivered',
			cta: 'Read the daily report',
		},
		fr: {
			support: 'Une journée de service, sa ponctualité et ses trajets effectués',
			cta: 'Lire le rapport quotidien',
		},
	},
	'/alerts': {
		en: {
			support: 'Past notices from the transit agency and the service they affect',
			cta: 'Browse notices',
		},
		fr: {
			support: 'Avis de service passés et services touchés',
			cta: 'Voir les avis',
		},
	},
	'/privacy': {
		en: {
			support: 'Visit measurement, location and browser storage',
			cta: 'Read the privacy policy',
		},
		fr: {
			support: 'Mesure des visites, localisation et stockage',
			cta: 'Lire la confidentialité',
		},
	},
	'/terms': {
		en: {
			support: 'Transit site and public data terms of use',
			cta: 'Read the terms',
		},
		fr: {
			support: 'Conditions du site Transit et des données publiques',
			cta: 'Lire les conditions',
		},
	},
	'/accessibility': {
		en: {
			support: 'Transit accessibility goals and known limitations',
			cta: 'Read the statement',
		},
		fr: {
			support: 'Objectifs d’accessibilité et limites connues',
			cta: 'Lire la déclaration',
		},
	},
	'/roadmap': {
		en: {
			support: 'What Transit does today and what comes next',
			cta: 'Read the roadmap',
		},
		fr: {
			support: 'Ce que Transit fait aujourd’hui et ce qui suit',
			cta: 'Lire la feuille de route',
		},
	},
	'/lines/detail': {
		en: {
			support: 'How on time the line ran and how much of its service was delivered',
			cta: 'View the line',
		},
		fr: {
			support: 'La ponctualité de la ligne et ses trajets effectués, jour par jour',
			cta: 'Voir la ligne',
		},
	},
	'/stop/detail': {
		en: {
			support: 'How on time vehicles were at this stop, day by day',
			cta: 'View the stop',
		},
		fr: {
			support: 'La ponctualité des passages à cet arrêt, jour par jour',
			cta: 'Voir l’arrêt',
		},
	},
} as const;
export function shareKey(path: string): keyof typeof SHARE_COPY {
	if (path.startsWith('/lines/')) return '/lines/detail';
	if (path.startsWith('/stop/')) return '/stop/detail';
	return Object.hasOwn(SHARE_COPY, path) ? (path as keyof typeof SHARE_COPY) : '/';
}
export function shareCopy(path: string, locale: Locale) {
	return SHARE_COPY[shareKey(path)][locale];
}
export function withShareCta(text: string, label: string): string {
	const trimmed = text.trim();
	const invitation = label + '.';
	if (trimmed.endsWith(invitation)) return trimmed;
	return trimmed.replace(/[.]+$/u, '') + '. ' + invitation;
}
