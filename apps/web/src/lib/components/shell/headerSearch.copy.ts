// Header search words. Plain data: Node and Playwright import it without the app's aliases.
type Kind = 'route' | 'stop' | 'vehicle' | 'address';
// English: 1 is singular. French: 0 and 1 are.
const count = (n: number, one: string, many: string, singular = n === 1) =>
	`${n} ${singular ? one : many}`;

export const headerSearchCopy = {
	en: {
		kind: { route: 'Line', stop: 'Stop', vehicle: 'Vehicle', address: 'Address' },
		heading: (kind: Kind, n: number | null) =>
			`${{ route: 'Lines', stop: 'Stops', vehicle: 'Live vehicles', address: 'Addresses' }[kind]}${n === null ? '' : ` · ${n}`}`,
		seeAll: (n: number, query: string) =>
			n === 1 ? `See 1 result for “${query}”` : `See all ${n} results for “${query}”`,
		noResult: (query: string) => `No line or stop matches “${query}”.`,
		browseLines: 'Browse all lines',
		browseStops: 'Browse all stops',
		totals: (lines: number, stops: number, vehicles: number) =>
			[
				count(lines, 'line', 'lines'),
				count(stops, 'stop', 'stops'),
				...(vehicles ? [count(vehicles, 'live vehicle', 'live vehicles')] : []),
			].join(', '),
	},
	fr: {
		kind: { route: 'Ligne', stop: 'Arrêt', vehicle: 'Véhicule', address: 'Adresse' },
		heading: (kind: Kind, n: number | null) =>
			`${{ route: 'Lignes', stop: 'Arrêts', vehicle: 'Véhicules en direct', address: 'Adresses' }[kind]}${n === null ? '' : ` · ${n}`}`,
		seeAll: (n: number, query: string) =>
			n === 1 ? `Voir le résultat pour « ${query} »` : `Voir les ${n} résultats pour « ${query} »`,
		noResult: (query: string) => `Aucune ligne ni aucun arrêt ne correspond à « ${query} ».`,
		browseLines: 'Parcourir toutes les lignes',
		browseStops: 'Parcourir tous les arrêts',
		totals: (lines: number, stops: number, vehicles: number) =>
			[
				count(lines, 'ligne', 'lignes', lines < 2),
				count(stops, 'arrêt', 'arrêts', stops < 2),
				...(vehicles
					? [count(vehicles, 'véhicule en direct', 'véhicules en direct', vehicles < 2)]
					: []),
			].join(', '),
	},
};
