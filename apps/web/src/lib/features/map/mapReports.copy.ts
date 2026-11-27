import { defineCopy, type Locale } from '#lib/i18n/copy.ts';

export const copy = defineCopy({
	en: {
		copyLiveView: 'Copy link',
		copyDisclaimer: 'This link opens the live view, which changes.',
		copied: 'Link copied.',
		loading: 'Loading vehicle reports…',
		unavailableSource: 'Live vehicle reports are unavailable right now.',
		unavailableAlerts: 'The notice filter is unavailable right now.',
		timeZone: 'Time zone',
	},
	fr: {
		copyLiveView: 'Copier le lien',
		copyDisclaimer: 'Ce lien ouvre la vue en direct, dont le contenu change.',
		copied: 'Lien copié.',
		loading: 'Chargement des relevés de véhicules…',
		unavailableSource: 'Les relevés de véhicules en direct sont indisponibles pour l’instant.',
		unavailableAlerts: 'Le filtre d’avis est indisponible pour l’instant.',
		timeZone: 'Fuseau horaire',
	},
});

export type MapReportsCopy = (typeof copy)[Locale];

export function mapReportsCopy(locale: Locale): MapReportsCopy {
	return copy[locale];
}
