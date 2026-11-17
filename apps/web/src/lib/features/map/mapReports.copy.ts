import { defineCopy, type Locale } from '#lib/i18n/copy.ts';

/**
 * "Reports in this view" wording. Counts arrive already formatted for the locale, so this module
 * only decides agreement: English distinguishes 1, French counts 0 and 1 in the singular.
 */
export const copy = defineCopy({
	en: {
		viewSwitchLabel: 'Map view',
		mapTab: 'Map',
		reportsTab: 'Reports',
		reportsTitle: 'Reports in this view',
		reportsScope: 'Matching vehicle reports in the current map view',
		reportsCount: (count: string, noRecent: string, n: number, old: number) =>
			`${count} ${n === 1 ? 'report' : 'reports'}. Of these, ${noRecent} ${
				old === 1 ? 'has' : 'have'
			} no recent position.`,
		reportsEmpty: 'No reports match these filters.',
		unscoped: (count: string, n: number) =>
			`${count} matching ${n === 1 ? 'report has' : 'reports have'} no usable location and ${
				n === 1 ? 'is' : 'are'
			} not in this view.`,
		copyLiveView: 'Copy live view link',
		copyDisclaimer: 'This link opens the live view, which changes.',
		downloadCsv: 'Download displayed reports (CSV)',
		copied: 'Link copied.',
		copyFailed: 'Could not copy the link. Copy it from the address bar.',
		loading: 'Loading vehicle reports…',
		unavailableView: 'Reports are unavailable until the map view is ready.',
		unavailableSource: 'Live vehicle reports are unavailable right now.',
		unavailableClock: 'Vehicle report times are unavailable right now.',
		retainedWarning: 'Live updates are failing. These are the last available reports.',
		staleWarning: 'The live feed has not updated recently. These are the last available reports.',
		sourceTime: 'Source time',
		timeZone: 'Time zone',
		reportAge: 'Age',
		statusColumn: 'Status',
		delayColumn: 'Delay',
		lineUnknown: 'Line unknown',
		reportedAt: (time: string) => `Reported ${time}`,
		sourceUpdatedAt: (time: string) => `Source updated ${time}`,
		selectVehicle: (id: string) => `Select vehicle ${id}`,
	},
	fr: {
		viewSwitchLabel: 'Vue de la carte',
		mapTab: 'Carte',
		reportsTab: 'Relevés',
		reportsTitle: 'Relevés dans cette vue',
		reportsScope: 'Relevés de véhicules correspondant à la vue actuelle de la carte',
		reportsCount: (count: string, noRecent: string, n: number, old: number) =>
			`${count} ${n < 2 ? 'relevé' : 'relevés'}. Parmi ceux-ci, ${noRecent} ${
				old < 2 ? 'n’a pas' : 'n’ont pas'
			} de position récente.`,
		reportsEmpty: 'Aucun relevé ne correspond à ces filtres.',
		unscoped: (count: string, n: number) =>
			`${count} ${n < 2 ? 'relevé correspondant n’a pas' : 'relevés correspondants n’ont pas'} de position utilisable et ${
				n < 2 ? 'ne figure pas' : 'ne figurent pas'
			} dans cette vue.`,
		copyLiveView: 'Copier le lien de la vue en direct',
		copyDisclaimer: 'Ce lien ouvre la vue en direct, dont le contenu change.',
		downloadCsv: 'Télécharger les relevés affichés (CSV)',
		copied: 'Lien copié.',
		copyFailed: 'Impossible de copier le lien. Copiez-le depuis la barre d’adresse.',
		loading: 'Chargement des relevés de véhicules…',
		unavailableView: 'Les relevés sont indisponibles tant que la vue de la carte n’est pas prête.',
		unavailableSource: 'Les relevés de véhicules en direct sont indisponibles pour l’instant.',
		unavailableClock: 'Les heures des relevés de véhicules sont indisponibles pour l’instant.',
		retainedWarning: 'Les mises à jour en direct échouent. Voici les derniers relevés disponibles.',
		staleWarning:
			'Le flux en direct n’a pas été mis à jour récemment. Voici les derniers relevés disponibles.',
		sourceTime: 'Heure de la source',
		timeZone: 'Fuseau horaire',
		reportAge: 'Âge',
		statusColumn: 'Statut',
		delayColumn: 'Retard',
		lineUnknown: 'Ligne inconnue',
		reportedAt: (time: string) => `Reçu à ${time}`,
		sourceUpdatedAt: (time: string) => `Source mise à jour à ${time}`,
		selectVehicle: (id: string) => `Choisir le véhicule ${id}`,
	},
});

export type MapReportsCopy = (typeof copy)[Locale];

export function mapReportsCopy(locale: Locale): MapReportsCopy {
	return copy[locale];
}
