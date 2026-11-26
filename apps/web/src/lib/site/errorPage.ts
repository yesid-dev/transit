import type { Locale } from '#lib/i18n/index.ts';

export interface ErrorPageLocaleCopy {
	suggestionsLabel: string;
	generic: {
		label: string;
		heading: string;
		body: string;
		home: string;
	};
	notFound: {
		label: string;
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
}

export const errorPageCopy: Record<Locale, ErrorPageLocaleCopy> = {
	fr: {
		suggestionsLabel: 'Destinations suggérées',
		generic: {
			label: 'HORS SERVICE',
			heading: 'Une erreur est survenue',
			body: 'Quelque chose s’est mal passé en chargeant cette vue. Réessayez ou revenez à l’accueil.',
			home: 'Retour à l’accueil',
		},
		notFound: {
			label: 'ROUTE INTROUVABLE',
			heading: 'Cette station est en construction',
			description:
				'La route demandée n’existe pas ou a été redirigée. Voici quelques destinations actives :',
			statusNote: '// chemin demandé hors service',
			suggestions: [
				{ label: 'Lignes', href: '/lines' },
				{ label: 'Arrêts', href: '/stops' },
				{ label: 'Réseau', href: '/network' },
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
	},
	en: {
		suggestionsLabel: 'Suggested destinations',
		generic: {
			label: 'OUT OF SERVICE',
			heading: 'Something went wrong',
			body: 'Something failed while loading this view. Try again or head back home.',
			home: 'Back to home',
		},
		notFound: {
			label: 'ROUTE NOT FOUND',
			heading: 'This station is under construction',
			description:
				"The route you requested doesn't exist or has been rerouted. Here are some active destinations:",
			statusNote: '// requested path not in service',
			suggestions: [
				{ label: 'Lines', href: '/lines' },
				{ label: 'Stops', href: '/stops' },
				{ label: 'Network', href: '/network' },
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
