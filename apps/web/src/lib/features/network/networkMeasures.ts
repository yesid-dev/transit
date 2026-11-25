export const networkMeasures = {
	poll_success: {
		title: ['Feed check success', 'Vérifications réussies des flux'],
		description: [
			'This shows how often Transit could read each live feed when checking for updates.',
			'Ce taux indique à quelle fréquence Transit a pu lire chaque flux en direct lors de ses vérifications.',
		],
	},
	feed_age_at_capture: {
		title: ['Feed age at capture', 'Âge des flux à la collecte'],
		description: [
			'This shows how old the live information was when Transit received it.',
			'Cette mesure indique depuis combien de temps les données en direct avaient été publiées quand Transit les a reçues.',
		],
	},
	feed_update_interval: {
		title: ['Time between feed updates', 'Temps entre les mises à jour des flux'],
		description: [
			'This shows how long you might wait for each live feed to publish new information.',
			'Cette mesure indique combien de temps vous pourriez attendre avant que chaque flux publie de nouvelles données.',
		],
	},
	live_trip_coverage: {
		title: ['Live trip coverage', 'Couverture des trajets en direct'],
		description: [
			'This shows how often scheduled trips appeared in live data on lines seen in the feed during these dates.',
			'Ce taux indique à quelle fréquence les trajets prévus sont apparus dans les données en direct sur les lignes vues dans le flux à ces dates.',
		],
	},
	vehicle_field_completeness: {
		title: ['Details in vehicle reports', 'Données des véhicules'],
		description: [
			'This shows how much vehicle reporting time included each detail you might rely on, such as position or occupancy.',
			'Ce taux indique la part du temps de signalement où chaque détail était disponible, comme la position ou l’occupation.',
		],
	},
	prediction_error: {
		title: ['Arrival prediction accuracy', 'Précision des prévisions d’arrivée'],
		description: [
			'This shows how closely forecasts made at different lead times matched observed arrivals.',
			'Cette mesure indique à quel point les prévisions faites à différentes échéances correspondaient aux arrivées observées.',
		],
	},
} satisfies Record<string, { title: [string, string]; description: [string, string] }>;

export type NetworkMeasure = keyof typeof networkMeasures;
