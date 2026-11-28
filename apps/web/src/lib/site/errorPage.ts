import type { Locale } from '#lib/i18n/index.ts';

export const detailNotFoundCopy = {
	LINE_NOT_FOUND: {
		en: {
			heading: 'This line could not be found',
			body: 'Check the line number, or find the line in the list of lines.',
			suggestions: [
				{ label: 'Find a line', href: '/lines' },
				{ label: 'Search', href: '/search' },
			],
		},
		fr: {
			heading: 'Cette ligne est introuvable',
			body: 'Vérifiez le numéro de la ligne ou cherchez-la dans la liste des lignes.',
			suggestions: [
				{ label: 'Trouver une ligne', href: '/lines' },
				{ label: 'Recherche', href: '/search' },
			],
		},
	},
	VEHICLE_NOT_FOUND: {
		en: {
			heading: 'This vehicle could not be found',
			body: 'Check the vehicle number, or find it in the list of vehicles.',
			suggestions: [
				{ label: 'Find a vehicle', href: '/vehicles' },
				{ label: 'Search', href: '/search' },
			],
		},
		fr: {
			heading: 'Ce véhicule est introuvable',
			body: 'Vérifiez le numéro du véhicule ou cherchez-le dans la liste des véhicules.',
			suggestions: [
				{ label: 'Trouver un véhicule', href: '/vehicles' },
				{ label: 'Recherche', href: '/search' },
			],
		},
	},
	DEPARTURE_NOT_FOUND: {
		en: {
			heading: 'This departure could not be found',
			body: 'Check the scheduled departures for this line.',
			suggestions: [{ label: 'Find a line', href: '/lines' }],
		},
		fr: {
			heading: 'Ce départ est introuvable',
			body: 'Vérifiez les départs prévus pour cette ligne.',
			suggestions: [{ label: 'Trouver une ligne', href: '/lines' }],
		},
	},
} as const;

export function detailNotFound(code: App.Error['code'], locale: Locale) {
	switch (code) {
		case 'LINE_NOT_FOUND':
		case 'VEHICLE_NOT_FOUND':
		case 'DEPARTURE_NOT_FOUND':
			return detailNotFoundCopy[code][locale];
	}
}

export interface ErrorPageLocaleCopy {
	suggestionsLabel: string;
	generic: {
		label: string;
		heading: string;
		body: string;
		home: string;
	};
	notFound: {
		heading: string;
		description: string;
		statusNote: string;
		suggestions: readonly { label: string; href: string }[];
	};
	stopNotFound: {
		heading: string;
		body: string;
		suggestions: readonly { label: string; href: string }[];
	};
	tripEnded: {
		heading: string;
		body: string;
		line: string;
		suggestions: readonly { label: string; href: string }[];
	};
	/** A trip ID the live feed does not hold, with no sign it ever ran: it may be a typo. */
	tripUnavailable: {
		heading: string;
		body: string;
		suggestions: readonly { label: string; href: string }[];
	};
}

export const errorPageCopy: Record<Locale, ErrorPageLocaleCopy> = {
	fr: {
		suggestionsLabel: 'Destinations suggérées',
		generic: {
			label: 'HORS SERVICE',
			heading: 'Cette page n’a pas pu se charger',
			body: 'Réessayez ou revenez à l’aperçu.',
			home: 'Retour à l’aperçu',
		},
		notFound: {
			heading: 'Cette page n’existe pas',
			description: 'Vérifiez l’adresse ou ouvrez l’une de ces pages.',
			statusNote: '// aucune page à cette adresse',
			suggestions: [
				{ label: 'Aperçu', href: '/' },
				{ label: 'Recherche', href: '/search' },
				{ label: 'Lignes', href: '/lines' },
				{ label: 'Arrêts', href: '/stops' },
				{ label: 'Santé du réseau', href: '/network' },
			],
		},
		stopNotFound: {
			heading: 'Cet arrêt est introuvable',
			body: 'Vérifiez le code de l’arrêt ou cherchez-le dans la liste des arrêts.',
			suggestions: [
				{ label: 'Trouver un arrêt', href: '/stops' },
				{ label: 'Lignes', href: '/lines' },
			],
		},
		tripUnavailable: {
			heading: 'Ce trajet n’est pas accessible dans la vue En direct',
			body: 'Vérifiez le lien du trajet ou cherchez sa ligne.',
			suggestions: [
				{ label: 'Lignes', href: '/lines' },
				{ label: 'Recherche', href: '/search' },
			],
		},
		tripEnded: {
			heading: 'Ce trajet ne circule plus',
			body: 'Un trajet quitte la vue en direct quand il se termine. Sa ligne montre ce qui circule maintenant.',
			line: 'Voir sa ligne',
			suggestions: [
				{ label: 'Lignes', href: '/lines' },
				{ label: 'Aperçu', href: '/' },
			],
		},
	},
	en: {
		suggestionsLabel: 'Suggested destinations',
		generic: {
			label: 'OUT OF SERVICE',
			heading: 'This page could not load',
			body: 'Try again, or go back to the overview.',
			home: 'Back to the overview',
		},
		notFound: {
			heading: 'This page does not exist',
			description: 'Check the address, or open one of these pages.',
			statusNote: '// no page at this address',
			suggestions: [
				{ label: 'Overview', href: '/' },
				{ label: 'Search', href: '/search' },
				{ label: 'Lines', href: '/lines' },
				{ label: 'Stops', href: '/stops' },
				{ label: 'Network health', href: '/network' },
			],
		},
		stopNotFound: {
			heading: 'This stop could not be found',
			body: 'Check the stop code, or find the stop in the list of stops.',
			suggestions: [
				{ label: 'Find a stop', href: '/stops' },
				{ label: 'Lines', href: '/lines' },
			],
		},
		tripUnavailable: {
			heading: 'This trip is unavailable in Live',
			body: 'Check the trip link or find its line.',
			suggestions: [
				{ label: 'Lines', href: '/lines' },
				{ label: 'Search', href: '/search' },
			],
		},
		tripEnded: {
			heading: 'This trip is no longer running',
			body: 'A trip leaves the live view when it ends. Its line shows what runs now.',
			line: 'See its line',
			suggestions: [
				{ label: 'Lines', href: '/lines' },
				{ label: 'Overview', href: '/' },
			],
		},
	},
};

export function errorDocumentHead(
	status: number,
	locale: Locale,
	code?: App.Error['code'],
): {
	title: string;
	description: string;
} {
	const copy = errorPageCopy[locale];
	const detail = status === 404 ? detailNotFound(code, locale) : undefined;
	if (detail) return { title: `${status} · ${detail.heading}`, description: detail.body };
	if (status === 404 && code === 'TRIP_ENDED')
		return {
			title: `${status} · ${copy.tripEnded.heading}`,
			description: copy.tripEnded.body,
		};
	if (status === 404 && code === 'TRIP_UNAVAILABLE')
		return {
			title: `${status} · ${copy.tripUnavailable.heading}`,
			description: copy.tripUnavailable.body,
		};
	if (status === 404 && code === 'STOP_NOT_FOUND')
		return {
			title: `${status} · ${copy.stopNotFound.heading}`,
			description: copy.stopNotFound.body,
		};
	return status === 404
		? {
				title: `${status} · ${copy.notFound.heading}`,
				description: copy.notFound.description,
			}
		: {
				title: `${status} · ${copy.generic.heading}`,
				description: copy.generic.body,
			};
}
