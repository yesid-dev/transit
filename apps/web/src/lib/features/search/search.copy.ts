import { defineCopy, type Locale } from '#lib/i18n/copy.ts';
import { headerSearchCopy } from '#lib/components/shell/headerSearch.copy.ts';

export const copy = defineCopy({
	en: {
		inputLabel: headerSearchCopy.en.inputLabel,
		inputPlaceholder: 'For example 51, Laurier or 52847',
		scopeAll: 'All',
		stopsLabel: headerSearchCopy.en.kinds.stop,
		retry: 'Try again',
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
		inputLabel: headerSearchCopy.fr.inputLabel,
		inputPlaceholder: 'Par exemple 51, Laurier ou 52847',
		scopeAll: 'Tout',
		stopsLabel: headerSearchCopy.fr.kinds.stop,
		retry: 'Réessayer',
		vehicle: {
			busAria: (id: string) => `Bus en direct ${id}`,
			routeTag: (route: string) => `Ligne ${route}`,
			next: (stop: string) => `Prochain : ${stop}`,
			noNextStop: 'Aucun prochain arrêt',
			heading: 'Direction',
			delay: 'Retard',
		},
	},
});

export type VehicleResultCopy = (typeof copy)[Locale]['vehicle'];
