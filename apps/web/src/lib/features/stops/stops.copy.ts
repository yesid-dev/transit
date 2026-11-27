import { defineCopy } from '#lib/i18n/copy.ts';

export const indexCopy = defineCopy({
	fr: {
		heading: 'Arrêts',
		lineClear: 'Effacer le filtre de ligne',
		lineEmpty: 'Aucune ligne ne correspond.',
		noLineStops: 'Aucune liste d’arrêts publiée pour cette ligne.',
		nearMe: 'Arrêts près de moi',
		nearAddress: 'Près d’une adresse',
		nearAsking: 'Recherche de votre position…',
		nearActive:
			'Arrêts à moins de 1 km de votre position, du plus proche au plus loin. Votre position reste sur cette page ; elle n’est pas ajoutée à l’adresse.',
		nearClear: 'Ne plus utiliser ma position',
		nearDenied: 'L’accès à votre position a été refusé. Filtrez plutôt par nom ou par code.',
		nearTimeout: 'Votre position a mis trop de temps à arriver. Réessayez.',
		nearUnavailable: 'Votre position n’est pas disponible dans ce navigateur.',
		nearInsecure: 'La localisation exige une page sécurisée (https).',
		nearNone: 'Aucun arrêt à moins de 1 km de votre position.',
		noMatch: (query: string) => `Aucun arrêt ne correspond à « ${query} ».`,
		noMatchFilters: 'Aucun arrêt ne correspond à ces filtres.',
		clearFilters: 'Effacer les filtres',
	},
	en: {
		heading: 'Stops',
		lineClear: 'Clear line filter',
		lineEmpty: 'No lines match.',
		noLineStops: 'No published stop list for this line.',
		nearMe: 'Stops near me',
		nearAddress: 'Near an address',
		nearAsking: 'Finding your location…',
		nearActive:
			'Stops within 1 km of your location, nearest first. Your location stays on this page; it is not added to the address.',
		nearClear: 'Stop using my location',
		nearDenied: 'Location permission was refused. Filter by name or code instead.',
		nearTimeout: 'Your location took too long to arrive. Try again.',
		nearUnavailable: 'Your location is not available in this browser.',
		nearInsecure: 'Location needs a secure (https) page.',
		nearNone: 'No stop is within 1 km of your location.',
		noMatch: (query) => `No stop matches “${query}”.`,
		noMatchFilters: 'No stop matches these filters.',
		clearFilters: 'Clear filters',
	},
});
export const stopErrorLink = {
	en: { label: 'Seen an error?', title: 'About Transit' },
	fr: { label: 'Vous avez vu une erreur?', title: 'À propos de Transit' },
} as const;
