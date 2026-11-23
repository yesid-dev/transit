import { defineCopy, type Locale } from '#lib/i18n/copy.ts';
import type { SurfaceHeadCopy } from '#lib/components/surface/index.ts';

/** A result group on the search page. */
export type GroupKind = 'route' | 'stop' | 'page' | 'vehicle';

export const copy = defineCopy({
	en: {
		kicker: 'SEARCH',
		heading: 'Find a line, stop or vehicle',
		lede: 'Search by line number or name, stop name or code, recently observed vehicle number, or page name. Lines and stops open on their record.',
		inputLabel: 'Search lines, stops and vehicles',
		inputPlaceholder: 'Search a line, stop or vehicle',
		linesLabel: 'Lines',
		stopsLabel: 'Stops',
		vehiclesLabel: 'Vehicles',
		notTracked: 'This feed does not track vehicles by number.',
		retry: 'Try again',
		pagesLabel: 'Pages',
		scopeLabel: 'Show',
		scopeAll: 'All',
		modeLabel: 'Mode',
		scopeCount: (label, n) => `${label} (${n})`,
		idleTitle: 'Search a line, stop or vehicle',
		idleBody:
			'Type a line number, a line or stop name, a stop code, or a vehicle number to find it.',
		census: {
			examplesLabel: 'Try',
			examples: ['747', 'Berri-UQAM', 'Métro'],
		},
		/** Shown only past the preview, so always more than one. */
		showAll: (kind: GroupKind, n: number) =>
			`Show all ${n} ${{ route: 'lines', stop: 'stops', page: 'pages', vehicle: 'vehicles' }[kind]}`,
		showMore: (kind: GroupKind, n: number) =>
			`Show ${n} more ${
				n === 1
					? { route: 'line', stop: 'stop', page: 'page', vehicle: 'vehicle' }[kind]
					: { route: 'lines', stop: 'stops', page: 'pages', vehicle: 'vehicles' }[kind]
			}`,
		shown: (n: number, total: number) => `${n} of ${total} shown`,
		none: (kind: GroupKind, query: string) =>
			`No ${{ route: 'line', stop: 'stop', page: 'page', vehicle: 'vehicle' }[kind]} matches “${query}”.`,
		vehicle: {
			busAria: (id) => `Live bus ${id}`,
			routeTag: (route) => `Line ${route}`,
			next: (stop) => `Next: ${stop}`,
			noNextStop: 'No next stop',
			heading: 'Heading',
			delay: 'Delay',
		},
	},
	fr: {
		kicker: 'RECHERCHE',
		heading: 'Trouver une ligne, un arrêt ou un véhicule',
		lede: 'Cherchez par numéro ou nom de ligne, nom ou code d’arrêt, numéro de véhicule observé récemment ou nom de page. Les lignes et les arrêts s’ouvrent sur leur bilan.',
		inputLabel: 'Rechercher lignes, arrêts et véhicules',
		inputPlaceholder: 'Rechercher une ligne, un arrêt ou un véhicule',
		linesLabel: 'Lignes',
		stopsLabel: 'Arrêts',
		vehiclesLabel: 'Véhicules',
		notTracked: 'Ce flux ne permet pas de suivre les véhicules par numéro.',
		retry: 'Réessayer',
		pagesLabel: 'Pages',
		scopeLabel: 'Afficher',
		scopeAll: 'Tout',
		modeLabel: 'Mode',
		scopeCount: (label: string, n: number) => `${label} (${n})`,
		idleTitle: 'Rechercher une ligne, un arrêt ou un véhicule',
		idleBody:
			'Saisissez un numéro de ligne, un nom de ligne ou d’arrêt, un code d’arrêt, ou un numéro de véhicule pour le trouver.',
		census: {
			examplesLabel: 'Essayez',
			examples: ['747', 'Berri-UQAM', 'Métro'],
		},
		showAll: (kind: GroupKind, n: number) =>
			`Afficher les ${n} ${{ route: 'lignes', stop: 'arrêts', page: 'pages', vehicle: 'véhicules' }[kind]}`,
		// French counts 0 and 1 in the singular.
		showMore: (kind: GroupKind, n: number) =>
			n < 2
				? `Afficher ${n} ${{ route: 'autre ligne', stop: 'autre arrêt', page: 'autre page', vehicle: 'autre véhicule' }[kind]}`
				: `Afficher ${n} ${{ route: 'autres lignes', stop: 'autres arrêts', page: 'autres pages', vehicle: 'autres véhicules' }[kind]}`,
		shown: (n: number, total: number) => `${n} sur ${total} affichés`,
		none: (kind: GroupKind, query: string) =>
			`${{ route: 'Aucune ligne', stop: 'Aucun arrêt', page: 'Aucune page', vehicle: 'Aucun véhicule' }[kind]} ne correspond à « ${query} ».`,
		vehicle: {
			busAria: (id: string) => `Bus en direct ${id}`,
			routeTag: (route: string) => `Ligne ${route}`,
			next: (stop: string) => `Prochain : ${stop}`,
			noNextStop: 'Aucun prochain arrêt',
			heading: 'Direction',
			delay: 'Retard',
		},
	},
}) satisfies Readonly<Record<Locale, SurfaceHeadCopy>>;

export type SearchCopy = (typeof copy)[Locale];
export type VehicleResultCopy = SearchCopy['vehicle'];

export function searchExamples(provider: string | undefined, locale: Locale): readonly string[] {
	if (provider === 'stm') return copy[locale].census.examples;
	if (provider === 'octranspo') return ['1', 'Rideau', "Tunney's Pasture"];
	return locale === 'fr' ? ['Numéro de ligne', 'Nom d’arrêt'] : ['Line number', 'Stop name'];
}
