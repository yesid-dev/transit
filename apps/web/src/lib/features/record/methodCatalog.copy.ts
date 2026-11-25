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
		collapse: 'Collapse all',
		counts: 'What it counts',
		exclusions: 'What it leaves out',
		limits: 'What it cannot tell',
		since: 'Since when',
		missing: 'The method registry does not specify this.',
		minimum: 'Minimum sample',
		rankingMinimum: 'Minimum sample for rankings',
		files: 'The columns for measure CSV files are listed under Download.',
		downloadPage: 'Download the data',
		cleanTables: 'lists the clean source tables.',
		notes: 'Detailed method notes',
		archive: 'Methodology for the archived record',
		range: {
			title: 'The range on a ranking row',
			summary: 'The range shows uncertainty around a ranked value.',
			counts:
				'For shares, a 95% interval uses the number of observations or weights them by time where the measure calls for it. Delay percentiles show the precision of the histogram.',
			exclusions: 'Each ranking has its own minimum sample. Some measures have no estimated range.',
			limits: 'When ranges overlap, the observed gap can be chance.',
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
		collapse: 'Tout replier',
		counts: 'Ce que la mesure compte',
		exclusions: 'Ce que la mesure exclut',
		limits: 'Ce que la mesure ne peut pas dire',
		since: 'Depuis quand',
		missing: 'Le registre des méthodes ne le précise pas.',
		minimum: 'Échantillon minimal',
		rankingMinimum: 'Échantillon minimal pour les classements',
		files: 'Les colonnes des fichiers CSV des mesures figurent sous Télécharger. La page',
		downloadPage: 'Télécharger les données',
		cleanTables: 'répertorie les tables sources nettoyées.',
		notes: 'Détails de la méthode',
		archive: 'Méthode du bilan archivé',
		range: {
			title: 'L’intervalle dans un classement',
			summary: 'L’intervalle montre l’incertitude autour d’une valeur du classement.',
			counts:
				'Pour les parts, un intervalle à 95 % utilise le nombre d’observations ou les pondère selon la durée, selon la mesure. Les percentiles de retard montrent la précision de l’histogramme.',
			exclusions:
				'Chaque classement a son propre échantillon minimal. Certaines mesures n’ont pas d’intervalle estimé.',
			limits: 'Quand les intervalles se chevauchent, l’écart observé peut être dû au hasard.',
		},
		statesTitle: 'Six états, chacun nommé',
		statesNote:
			'Une lacune reste visible. Une valeur absente n’est jamais remplacée par un zéro rassurant.',
		states: {
			no_live_data:
				'L’agence ne publie aucun flux en temps réel pour cette ligne, comme le métro. Son horaire est affiché et elle est exclue de tous les taux.',
			not_measured:
				'La ligne ou la mesure existe, mais les données de ces dates ne permettent pas de la calculer. Elle n’est jamais affichée comme zéro.',
			too_few_to_judge:
				'Il y a des relevés, mais en nombre insuffisant pour tirer une conclusion. Le nombre et le minimum sont affichés.',
			delay_unknown:
				'Le véhicule ou le trajet est présent et son retard est inconnu, par exemple lorsqu’aucun véhicule ne signale sa position pour un trajet prévu.',
			not_reporting:
				'Le véhicule n’a transmis aucune position depuis 90 secondes, ou au cours d’une journée donnée. Il peut se trouver au garage ou circuler sans que son émetteur envoie de signal.',
			not_tracked:
				'Le flux ne fournit aucun identifiant stable pour suivre un véhicule d’un jour à l’autre.',
		},
		limitsTitle: 'Ce que ce bilan n’est pas',
		recordLimits: [
			'Pas un planificateur de trajets : il n’indique pas quelle ligne prendre.',
			'Pas une mesure des lignes sans données en direct, comme le métro ou l’O-Train : leurs agences ne publient aucune donnée en temps réel pour ces lignes.',
			'Pas un décompte des passagers, ni une cause du retard : ces données ne figurent pas dans les flux.',
			'Les heures observées proviennent des prévisions et des positions de l’agence, comparées entre elles, sans chronométrage à l’arrêt.',
		],
	},
} as const;
