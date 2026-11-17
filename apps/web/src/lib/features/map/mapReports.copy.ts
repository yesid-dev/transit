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
		stopsOnly: 'Scheduled stops are not vehicle position reports.',
		unscoped: (count: string, n: number) =>
			`${count} matching ${n === 1 ? 'report has' : 'reports have'} no usable location and ${
				n === 1 ? 'is' : 'are'
			} not in this view.`,
		copyLiveView: 'Copy live view link',
		copyDisclaimer: 'This link opens the live view, which changes.',
		downloadCsv: 'Download displayed reports (CSV)',
		copied: 'Link copied.',
		copyFailed: 'Could not copy the link.',
		loading: 'Loading vehicle reports…',
		loadingAlerts: 'Loading alert filter data…',
		unavailableView: 'Reports are unavailable until the map view is ready.',
		unavailableSource: 'Live vehicle reports are unavailable right now.',
		unavailableClock: 'Vehicle report times are unavailable right now.',
		unavailableAlerts: 'The alert filter is unavailable right now.',
		alertSourceTime: 'Alert source time',
		alertRetainedWarning: 'This filter uses the last available alerts.',
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
		stopsOnly: 'Les arrêts prévus à l’horaire ne sont pas des relevés de position de véhicules.',
		unscoped: (count: string, n: number) =>
			`${count} ${n < 2 ? 'relevé correspondant n’a pas' : 'relevés correspondants n’ont pas'} de position utilisable et ${
				n < 2 ? 'ne figure pas' : 'ne figurent pas'
			} dans cette vue.`,
		copyLiveView: 'Copier le lien de la vue en direct',
		copyDisclaimer: 'Ce lien ouvre la vue en direct, dont le contenu change.',
		downloadCsv: 'Télécharger les relevés affichés (CSV)',
		copied: 'Lien copié.',
		copyFailed: 'Impossible de copier le lien.',
		loading: 'Chargement des relevés de véhicules…',
		loadingAlerts: 'Chargement des données du filtre d’alertes…',
		unavailableView: 'Les relevés sont indisponibles tant que la vue de la carte n’est pas prête.',
		unavailableSource: 'Les relevés de véhicules en direct sont indisponibles pour l’instant.',
		unavailableClock: 'Les heures des relevés de véhicules sont indisponibles pour l’instant.',
		unavailableAlerts: 'Le filtre d’alertes est indisponible pour l’instant.',
		alertSourceTime: 'Heure de la source des alertes',
		alertRetainedWarning: 'Ce filtre utilise les dernières alertes disponibles.',
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
