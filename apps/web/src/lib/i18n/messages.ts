import { defineCopy } from '#lib/i18n/copy.ts';

export const navPillCopy = defineCopy({
	fr: {
		skipToContent: 'Aller au contenu',
		mapLabel: 'Carte du réseau',
		refresh: 'Actualiser les données',
		refreshing: 'Actualisation…',
		refreshFailed: 'Échec de l’actualisation ; réessayer',
		searchPlaceholder: {
			route: 'Rechercher une ligne…',
			stop: 'Rechercher un arrêt…',
			all: 'Ligne, arrêt, adresse…',
		},
		searchAria: {
			route: 'Rechercher une ligne',
			stop: 'Rechercher un arrêt',
			all: 'Rechercher dans le réseau',
		},

		searchCollectionNotice:
			'Vos recherches sont envoyées à notre serveur et au service Géo.ca du gouvernement du Canada.',
		openMenu: 'Ouvrir le menu',
		closeMenu: 'Fermer le menu',
		menu: 'Menu de navigation',
		theme: 'Thème sombre',
		nav: 'Navigation principale',
		language: 'Langue',
		menuFooter: '',
		names: { en: 'English', fr: 'Français' },
		network: 'Réseau de transport',
		defaultNetwork: 'Réseau par défaut',
		otherNetworksUnavailable: 'Autres réseaux indisponibles',
		newTab: '(nouvel onglet)',
	},
	en: {
		skipToContent: 'Skip to content',
		mapLabel: 'Network map',
		refresh: 'Refresh data',
		refreshing: 'Refreshing…',
		refreshFailed: 'Refresh failed; try again',
		searchPlaceholder: {
			route: 'Search a line…',
			stop: 'Search a stop…',
			all: 'Search a line, stop, or address…',
		},
		searchAria: { route: 'Search a line', stop: 'Search a stop', all: 'Search the network' },

		searchCollectionNotice:
			'Your searches are sent to our server and the Government of Canada Geo.ca service.',
		openMenu: 'Open menu',
		closeMenu: 'Close menu',
		menu: 'Navigation menu',
		theme: 'Dark theme',
		nav: 'Primary navigation',
		language: 'Language',
		menuFooter: '',
		names: { en: 'English', fr: 'Français' },
		network: 'Transit network',
		defaultNetwork: 'Default network',
		otherNetworksUnavailable: 'Other networks unavailable',
		newTab: '(opens in a new tab)',
	},
});
