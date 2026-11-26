// Header search words. Plain data: Node and Playwright import it without the app's aliases.
import type { SearchKind, SearchList, SearchScope } from '#lib/search/transitSearch.ts';

type Kind = SearchKind | 'address';
// English: 1 is singular. French: 0 and 1 are.
const count = (n: number, one: string, many: string, singular = n === 1) =>
	`${n} ${singular ? one : many}`;
// A null count was not searched: it is left out, never spoken as 0.
const counts = (...parts: (string | false)[]) => parts.filter(Boolean).join(', ');

export const headerSearchCopy = {
	en: {
		kind: { route: 'Line', stop: 'Stop', vehicle: 'Vehicle', page: 'Page', address: 'Address' },
		kinds: { route: 'Lines', stop: 'Stops', vehicle: 'Vehicles', page: 'Pages' },
		idleTitle: 'Nothing typed yet',
		idleBody: 'Results appear as you type: lines, stops, vehicles and pages.',
		short: 'Enter a line number or at least two letters.',
		loading: 'Loading the search index…',
		unavailable: 'The search index is temporarily unavailable.',
		notTracked: 'This feed does not track vehicles by number.',
		showing: (shown: string, total: string) => `Showing ${shown} of ${total}`,
		more: 'Show more',
		results: 'Results by kind',
		searched: { route: 'lines', stop: 'stops', vehicle: 'vehicles', page: 'pages' },
		sheetTitle: 'Search',
		closeSheet: 'Close search',
		heading: (kind: Kind, n: number | null) =>
			`${{ route: 'Lines', stop: 'Stops', vehicle: 'Vehicles', page: 'Pages', address: 'Addresses' }[kind]}${n === null ? '' : ` · ${n}`}`,
		seeAll: 'See all results',
		noResult: (query: string, kinds: string) => `Nothing found for “${query}” in ${kinds}.`,
		browseLines: 'Browse all lines',
		browseStops: 'Browse all stops',
		askAddresses: (query: string) => `Search addresses for “${query}”`,
		addressNotice:
			"Sends this text to our server and to the Government of Canada's Geo.ca service.",
		addressesLoading: 'Looking up addresses…',
		addressesNone: (query: string) => `No address found for “${query}”.`,
		addressesFailed: 'Address search is unavailable right now.',
		totals: (lines: number | null, stops: number | null, vehicles: number, pages = 0) =>
			counts(
				lines !== null && count(lines, 'line', 'lines'),
				stops !== null && count(stops, 'stop', 'stops'),
				vehicles > 0 && count(vehicles, 'vehicle', 'vehicles'),
				pages > 0 && count(pages, 'page', 'pages'),
			),
	},
	fr: {
		kind: { route: 'Ligne', stop: 'Arrêt', vehicle: 'Véhicule', page: 'Page', address: 'Adresse' },
		kinds: { route: 'Lignes', stop: 'Arrêts', vehicle: 'Véhicules', page: 'Pages' },
		idleTitle: 'Rien de saisi',
		idleBody: 'Les résultats s’affichent pendant la saisie : lignes, arrêts, véhicules et pages.',
		short: 'Saisissez un numéro de ligne ou au moins deux lettres.',
		loading: 'Chargement de l’index de recherche…',
		unavailable: 'L’index de recherche est temporairement indisponible.',
		notTracked: 'Ce flux ne permet pas de suivre les véhicules par numéro.',
		showing: (shown: string, total: string) => `${shown} sur ${total}`,
		more: 'Afficher plus',
		results: 'Résultats par type',
		searched: {
			route: 'les lignes',
			stop: 'les arrêts',
			vehicle: 'les véhicules',
			page: 'les pages',
		},
		sheetTitle: 'Recherche',
		closeSheet: 'Fermer la recherche',
		heading: (kind: Kind, n: number | null) =>
			`${{ route: 'Lignes', stop: 'Arrêts', vehicle: 'Véhicules', page: 'Pages', address: 'Adresses' }[kind]}${n === null ? '' : ` · ${n}`}`,
		seeAll: 'Voir tous les résultats',
		noResult: (query: string, kinds: string) => `Aucun résultat pour « ${query} » dans ${kinds}.`,
		browseLines: 'Parcourir toutes les lignes',
		browseStops: 'Parcourir tous les arrêts',
		askAddresses: (query: string) => `Chercher des adresses pour « ${query} »`,
		addressNotice:
			'Envoie ce texte à notre serveur et au service Géo.ca du gouvernement du Canada.',
		addressesLoading: 'Recherche d’adresses…',
		addressesNone: (query: string) => `Aucune adresse trouvée pour « ${query} ».`,
		addressesFailed: 'La recherche d’adresse est indisponible pour le moment.',
		totals: (lines: number | null, stops: number | null, vehicles: number, pages = 0) =>
			counts(
				lines !== null && count(lines, 'ligne', 'lignes', lines < 2),
				stops !== null && count(stops, 'arrêt', 'arrêts', stops < 2),
				vehicles > 0 && count(vehicles, 'véhicule', 'véhicules', vehicles < 2),
				pages > 0 && count(pages, 'page', 'pages', pages < 2),
			),
	},
};

export function searchListNotice(
	copy: (typeof headerSearchCopy)['en' | 'fr'],
	list: SearchList,
	query: string,
	state: 'empty' | 'short' | 'ready',
	scope: SearchScope = 'all',
): string {
	if (state === 'empty') return '';
	if (state === 'short') return copy.short;
	const kinds = scope === 'all' ? (Object.keys(copy.kinds) as SearchKind[]) : [scope];
	if (kinds.some((kind) => list.unsearched.some((missing) => missing === kind)))
		return list.indexSettled === false ? copy.loading : copy.unavailable;
	if (scope === 'vehicle' && list.vehiclesNotTracked) return copy.notTracked;
	if (list.groups.some((group) => group.total > 0 && kinds.some((kind) => kind === group.kind)))
		return '';
	const searched = kinds.filter((kind) => kind !== 'vehicle' || !list.vehiclesNotTracked);
	return copy.noResult(query, searched.map((kind) => copy.searched[kind]).join(', '));
}
