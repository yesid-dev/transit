export const downloadTables = {
	stop_events: {
		en: 'One row per trip stop. Compare scheduled and observed times, read delay (s) and see the evidence used (basis), the reported vehicle and any exclusion reason.',
		fr: 'Une ligne par arrêt d’une course. Comparez les heures prévues et observées, le retard (s), le type de preuve (basis), le véhicule signalé et le motif d’exclusion.',
	},
	trip_days: {
		en: 'One row per trip and service day. Includes the scheduled start, trip state and reason, assigned vehicle, first and last observations, cancellation notice and terminus evidence.',
		fr: 'Une ligne par course et journée de service. Comprend le départ prévu, l’état et son motif, le véhicule affecté, les premières et dernières observations, l’avis d’annulation et la preuve d’arrivée au terminus.',
	},
	scheduled_stop_times: {
		en: 'One row per scheduled trip stop. Includes stop order, planned arrival and departure in UTC and as a service-day offset (s), the schedule edition checksum and wheelchair boarding information.',
		fr: 'Une ligne par arrêt prévu d’une course. Comprend l’ordre des arrêts, les heures prévues d’arrivée et de départ en UTC et en décalage depuis le début du jour de service (s), la somme de contrôle de l’édition et l’accessibilité à l’embarquement.',
	},
	vehicle_positions: {
		en: 'Position readings with latitude, longitude, vehicle and optional trip and stop identifiers. Capture and observation times distinguish when Transit received the reading from when it was recorded. Repeated readings include a count and a last-seen time.',
		fr: 'Relevés de position avec latitude, longitude, identifiant du véhicule et, si disponibles, de la course et de l’arrêt. Les heures de capture et d’observation distinguent la réception par Transit du moment du relevé. Un compteur et l’heure de dernière observation accompagnent les relevés répétés.',
	},
	alerts: {
		en: 'One row per alert version and source. Includes the text available in each language, affected lines and stops, active periods and the reported cause and effect.',
		fr: 'Une ligne par version et par source d’avis. Comprend le texte disponible dans chaque langue, les lignes et arrêts touchés, les périodes actives, la cause et l’effet signalés.',
	},
	feed_polls: {
		en: 'One row per feed retrieval attempt. Includes the feed, capture and feed timestamps, result, payload size and entity count when available.',
		fr: 'Une ligne par tentative de collecte. Comprend le flux, les horodatages de collecte et du flux, le résultat, la taille du contenu et le nombre d’entités si disponible.',
	},
	prediction_samples: {
		en: 'One sample per observed trip stop and prediction horizon. Includes publication and predicted times, actual lead time and prediction error (s).',
		fr: 'Un échantillon par arrêt observé d’une course et par horizon de prévision. Comprend les heures de publication et de passage prévu, le délai réel avant le passage et l’erreur de prévision (s).',
	},
	segment_runs: {
		en: 'One row per pair of consecutive scheduled stops on a trip. Includes stop order, observed timestamps and their evidence, elapsed observed and scheduled seconds, and any exclusion before checking feed coverage.',
		fr: 'Une ligne par paire d’arrêts prévus consécutifs d’une course. Comprend l’ordre des arrêts, les heures observées et leurs sources, les durées observée et prévue en secondes et tout motif d’exclusion avant de vérifier la couverture des flux.',
	},
};

export const missingDayReasons = {
	no_manifest: {
		en: 'There is no published manifest for this date and cleaning version.',
		fr: 'Aucun manifeste n’a été publié pour cette date et cette version du nettoyage.',
	},
	no_raw_captures: {
		en: 'No raw feed captures were available for this day.',
		fr: 'Aucune capture brute des flux n’était disponible pour cette journée.',
	},
	no_schedule_edition: {
		en: 'No schedule edition was available for this day.',
		fr: 'Aucune édition des horaires n’était disponible pour cette journée.',
	},
	schedule_archive_unreadable: {
		en: 'The schedule archive for this day could not be read.',
		fr: 'L’archive des horaires de cette journée était illisible.',
	},
};
