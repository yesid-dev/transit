import type { RecordState } from './recordStates';

export const methodReferenceStates = [
	'no_live_data',
	'not_measured',
	'too_few_to_judge',
	'delay_unknown',
	'not_reporting',
	'not_tracked',
] as const satisfies readonly RecordState[];

export const methodCopy = {
	en: {
		intro:
			'On time means between 1 minute early and 5 minutes late, counted at each scheduled stop. Every screen, every file and this page use the same definitions.',
		heading: 'The measures',
		more: 'More measures',
		counts: 'What it counts',
		exclusions: 'What it leaves out',
		limits: 'What it cannot tell',
		since: 'In use since',
		sameAs: 'The same as',
		sharedAcross: 'Shared across these measures',
		minimum: 'Minimum sample',
		rankingMinimum: 'Minimum sample for rankings',
		files: 'The columns for measure CSV files are listed under Download.',
		downloadPage: 'Download the data',
		cleanTables: 'lists the daily source files.',
		dataUsers: 'For data users',
		archive: 'Methodology for the archived record',
		range: {
			title: 'The range on a ranking row',
			summary: 'The range shows uncertainty around a ranked value.',
			counts:
				'For shares, the range shows where the true rate would likely sit across repeated samples; for delay percentiles, it shows the rounding step of the grouped counts.',
			exclusions:
				'Each ranking sets its own minimum sample, and measures without a reliable uncertainty model show no range.',
			limits:
				'When two rows have overlapping ranges, the gap between them may be chance rather than a real difference.',
			dataUsers: {
				counts:
					'Share rankings compute a 95% Wilson score interval from the sample size (or an effective sample size weighted by scheduled duration for service hours, and by vehicle time for occupancy). Delay and corridor percentiles use half the histogram bin width around the estimate (±7 s for 15-s delay bins and ±2 s for 5-s corridor bins).',
				exclusions:
					'Worst-first share rankings sort by the cautious end of the 95% Wilson interval (the upper end for on-time and delivered shares, the lower end for early, late, cancelled, missing, bunched and full shares), while displaying the exact observed share on the row. Ties break by larger sample size, then entity ID. Excess wait, reporting-gap rates and total vehicle-minutes lost show no uncertainty range.',
				limits:
					'Stop events on the same trip, intervals from the same vehicle and trips on the same vehicle can be correlated; treat the 95% Wilson interval as a guide rather than an exact probability guarantee.',
			},
		},
		statesTitle: 'Six states, each said in words',
		statesNote: 'A gap is shown as a gap. An absent value is never a reassuring zero.',
		states: {
			no_live_data:
				'The agency publishes no realtime feed for this line, such as the métro. It is shown with its schedule and left out of every rate.',
			not_measured:
				'The line or the measure exists, and the data on these dates cannot support it. It is never shown as zero.',
			too_few_to_judge:
				'There are readings, and too few of them to say anything fair. The count and the minimum are shown.',
			delay_unknown:
				'A vehicle or a trip is there and its delay is not known, for example a scheduled vehicle with no vehicle reporting.',
			not_reporting:
				'A vehicle sent no position in the last 90 seconds, or on a given day. It is not the same as out of service: the vehicle may be in the garage, or on the road with a transmitter that sends nothing.',
			not_tracked:
				'The feed gives its vehicles no stable number, so a vehicle cannot be followed from one day to the next.',
		},
		limitsTitle: 'What this record is not',
		recordLimits: [
			'Not a trip planner: it does not tell you which line to take.',
			'Not a measure of lines without live data, such as the métro or the O-Train: their agencies publish no realtime data for them.',
			'Not a count of riders, and not a cause of delay: neither is in the feeds.',
			'Observed times are the agency’s own predictions and positions, checked against each other, not a stopwatch at the stop.',
		],
	},
	fr: {
		intro:
			'Un passage prévu est à l’heure s’il a lieu entre 1 minute d’avance et 5 minutes de retard. Les écrans, les fichiers et cette page utilisent les mêmes définitions.',
		heading: 'Les mesures',
		more: 'Autres mesures',
		counts: 'Ce que la mesure compte',
		exclusions: 'Ce que la mesure exclut',
		limits: 'Ce que la mesure ne peut pas dire',
		since: 'En vigueur depuis',
		sameAs: 'Comme pour',
		sharedAcross: 'Commun à ces mesures',
		minimum: 'Échantillon minimal',
		rankingMinimum: 'Échantillon minimal pour les classements',
		files: 'Les colonnes des fichiers CSV des mesures figurent sous Télécharger. La page',
		downloadPage: 'Télécharger les données',
		cleanTables: 'répertorie les fichiers sources quotidiens.',
		dataUsers: 'Pour les utilisateurs de données',
		archive: 'Méthode du bilan archivé',
		range: {
			title: 'L’intervalle dans un classement',
			summary: 'L’intervalle montre l’incertitude autour d’une valeur du classement.',
			counts:
				'Pour les parts, l’intervalle indique où la vraie valeur se situerait le plus souvent; pour les centiles de retard, il montre la précision des tranches de calcul.',
			exclusions:
				'Chaque classement fixe son propre échantillon minimal, et les mesures sans modèle d’incertitude fiable n’affichent aucun intervalle.',
			limits:
				'Quand deux intervalles se chevauchent, l’écart observé peut être dû au hasard plutôt qu’à une différence réelle.',
			dataUsers: {
				counts:
					'Les classements de parts calculent un intervalle de Wilson à 95\u00a0% à partir de l’effectif (ou d’un effectif pondéré par la durée prévue pour les heures de service et par le temps-véhicule pour l’occupation). Les centiles de retard et de corridor utilisent la demi-largeur de classe autour de l’estimation (±7\u00a0s pour les classes de 15\u00a0s et ±2\u00a0s pour les classes de 5\u00a0s).',
				exclusions:
					'Les classements de parts trient selon la borne prudente de l’intervalle de Wilson à 95\u00a0% (borne supérieure pour les parts à l’heure et les trajets effectués; borne inférieure pour les parts en avance, en retard, annulées, manquantes, rapprochées et pleines), tout en affichant la part observée exacte sur la ligne. Les égalités sont départagées par l’effectif décroissant, puis par l’identifiant. L’attente excédentaire, les taux d’interruptions et le total des minutes-véhicules perdues n’affichent aucun intervalle.',
				limits:
					'Les passages aux arrêts d’un même trajet, les intervalles d’un même véhicule et les trajets d’un même véhicule peuvent être dépendants; cet intervalle à 95\u00a0% sert de guide plutôt que de garantie exacte.',
			},
		},
		statesTitle: 'Six états, chacun nommé',
		statesNote:
			'Une lacune reste visible. Une valeur absente n’est jamais remplacée par un zéro rassurant.',
		states: {
			no_live_data:
				'La société de transport ne publie aucun flux en temps réel pour cette ligne, comme le métro. Son horaire est affiché et elle est exclue de tous les taux.',
			not_measured:
				'La ligne ou la mesure existe, mais les données de ces dates ne permettent pas de la calculer. Elle n’est jamais affichée comme zéro.',
			too_few_to_judge:
				'Il y a des relevés, mais en nombre insuffisant pour tirer une conclusion. Le nombre et le minimum sont affichés.',
			delay_unknown:
				'Le véhicule ou le trajet est présent et son retard est inconnu, par exemple lorsqu’aucun véhicule ne signale sa position pour un trajet prévu.',
			not_reporting:
				'Le véhicule n’a transmis aucune position depuis 90 secondes, ou au cours d’une journée donnée. Cela ne veut pas dire qu’il est hors service\u00a0: il peut être au garage ou rouler sans que son émetteur envoie de signal.',
			not_tracked:
				'Le flux ne fournit aucun identifiant stable pour suivre un véhicule d’un jour à l’autre.',
		},
		limitsTitle: 'Ce que ce bilan n’est pas',
		recordLimits: [
			'Pas un planificateur de trajets\u00a0: il n’indique pas quelle ligne prendre.',
			'Pas une mesure des lignes sans données en direct, comme le métro ou l’O-Train\u00a0: leurs sociétés de transport ne publient aucune donnée en temps réel pour ces lignes.',
			'Pas un décompte des usagers, ni une cause du retard\u00a0: ces données ne figurent pas dans les flux.',
			'Les heures observées proviennent des prévisions et des positions de la société de transport, comparées entre elles, sans chronométrage à l’arrêt.',
		],
	},
} as const;
