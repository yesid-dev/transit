// Header search words. Plain data: Node and Playwright import it without the app's aliases.
type Kind = 'route' | 'stop' | 'vehicle' | 'address';
// English: 1 is singular. French: 0 and 1 are.
const count = (n: number, one: string, many: string, singular = n === 1) =>
	`${n} ${singular ? one : many}`;
// A null count was not searched: it is left out, never spoken as 0.
const counts = (...parts: (string | false)[]) => parts.filter(Boolean).join(', ');

export const headerSearchCopy = {
	en: {
		kind: { route: 'Line', stop: 'Stop', vehicle: 'Vehicle', address: 'Address' },
		heading: (kind: Kind, n: number | null) =>
			`${{ route: 'Lines', stop: 'Stops', vehicle: 'Live vehicles', address: 'Addresses' }[kind]}${n === null ? '' : ` · ${n}`}`,
		seeAll: (n: number | null, query: string) =>
			`See ${n === 1 ? '1 result' : n === null ? 'all results' : `all ${n} results`} for “${query}”`,
		unsearched: (kind: 'route' | 'stop') =>
			`${kind === 'route' ? 'Lines' : 'Stops'} have not been searched yet.`,
		noResult: (query: string) => `No line or stop matches “${query}”.`,
		browseLines: 'Browse all lines',
		browseStops: 'Browse all stops',
		totals: (lines: number | null, stops: number | null, vehicles: number) =>
			counts(
				lines !== null && count(lines, 'line', 'lines'),
				stops !== null && count(stops, 'stop', 'stops'),
				vehicles > 0 && count(vehicles, 'live vehicle', 'live vehicles'),
			),
	},
	fr: {
		kind: { route: 'Ligne', stop: 'Arrêt', vehicle: 'Véhicule', address: 'Adresse' },
		heading: (kind: Kind, n: number | null) =>
			`${{ route: 'Lignes', stop: 'Arrêts', vehicle: 'Véhicules en direct', address: 'Adresses' }[kind]}${n === null ? '' : ` · ${n}`}`,
		seeAll: (n: number | null, query: string) =>
			`Voir ${n === 1 ? 'le résultat' : n === null ? 'tous les résultats' : `les ${n} résultats`} pour « ${query} »`,
		unsearched: (kind: 'route' | 'stop') =>
			`Les ${kind === 'route' ? 'lignes n’ont pas encore été cherchées' : 'arrêts n’ont pas encore été cherchés'}.`,
		noResult: (query: string) => `Aucune ligne ni aucun arrêt ne correspond à « ${query} ».`,
		browseLines: 'Parcourir toutes les lignes',
		browseStops: 'Parcourir tous les arrêts',
		totals: (lines: number | null, stops: number | null, vehicles: number) =>
			counts(
				lines !== null && count(lines, 'ligne', 'lignes', lines < 2),
				stops !== null && count(stops, 'arrêt', 'arrêts', stops < 2),
				vehicles > 0 && count(vehicles, 'véhicule en direct', 'véhicules en direct', vehicles < 2),
			),
	},
};
