import { defineCopy } from '#lib/i18n/copy.ts';

export const tripCopy = defineCopy({
	fr: {
		observedCaveat: 'Ce sont des prévisions, pas des arrivées observées.',
		columns: { stop: 'Arrêt', time: 'Heure prévue', offset: 'Écart signalé' },
		showAll: (n: number) => `Voir les ${n} prévisions`,
		showFewer: 'Voir moins de prévisions',
		download: 'Télécharger toutes les prévisions (CSV)',

		reportedPredictions: 'Prévisions communiquées',
		viewStop: 'Voir l’arrêt',
		predictionCaveat:
			'Les prédictions couvrent jusqu’à une heure au moment de la préparation du rapport. Elles peuvent changer.',
		noPredictions: 'Aucune prévision communiquée pour ce trajet dans cette fenêtre.',
		latestReport: 'Dernier rapport',
		refreshUnavailable: 'Actualisation indisponible',
		reportBehind: 'Rapport en retard',
		retainedReport:
			'Le dernier rapport reçu reste affiché. Ses prédictions peuvent ne plus être à jour.',
	},
	en: {
		observedCaveat: 'These are predictions, not observed arrivals.',
		columns: { stop: 'Stop', time: 'Predicted time', offset: 'Reported offset' },
		showAll: (n: number) => `Show all ${n} predictions`,
		showFewer: 'Show fewer predictions',
		download: 'Download all predictions (CSV)',

		reportedPredictions: 'Reported predictions',
		viewStop: 'View stop',
		predictionCaveat:
			'Predictions cover up to one hour when the report is prepared. They may change.',
		noPredictions: 'No predictions reported for this trip in this window.',
		latestReport: 'Latest report',
		refreshUnavailable: 'Refresh unavailable',
		reportBehind: 'Report behind schedule',
		retainedReport: 'Showing the last report received. Its predictions may no longer be current.',
	},
});
