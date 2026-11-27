import { defineCopy } from '#lib/i18n/copy.ts';
import { headerSearchCopy } from '#lib/components/shell/headerSearch.copy.ts';

export const copy = defineCopy({
	en: {
		lede: 'Type a line number, a street, a stop code, a vehicle number or the name of a page.',
		inputLabel: 'Line, stop, vehicle or page',
		examples: (words: string) => 'For example ' + words,
		trySearch: 'Try a search',
		nearby: 'Find stops on the map',
		scopeAll: 'All',
		stopsLabel: headerSearchCopy.en.kinds.stop,
		retry: 'Try again',
	},
	fr: {
		lede: 'Saisissez un numéro de ligne, une rue, un code d’arrêt, un numéro de véhicule ou le nom d’une page.',
		inputLabel: 'Ligne, arrêt, véhicule ou page',
		examples: (words: string) => 'Par exemple ' + words,
		trySearch: 'Essayez une recherche',
		nearby: 'Trouver des arrêts sur la carte',
		scopeAll: 'Tout',
		stopsLabel: headerSearchCopy.fr.kinds.stop,
		retry: 'Réessayer',
	},
});
