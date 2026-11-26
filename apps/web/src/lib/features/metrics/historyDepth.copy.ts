import { defineCopy } from '#lib/i18n/copy.ts';

export const historyDepthCopy = defineCopy({
	en: {
		title: 'Published history',
		question: 'How far back do these measures go?',
		intro:
			'These are the dates published for each metric group and dimension: the whole network, lines or stops. They do not guarantee that every individual measure, line or stop has records throughout that window.',
		limits:
			'Additive groups combine their underlying counts across days; this does not mean averaging daily percentages. Daily-only values stay separate. In particular, daily percentiles cannot be averaged or pooled into a percentile for another period.',
		unknown: 'Not published',
		noList: 'The history date list is not published. The available depth is unknown, not zero.',
		noInventory:
			'No metric-group history inventory is published for this dimension. That does not mean zero history.',
		noGaps: 'No missing days declared',
		unknownGaps: 'Missing days not published',
		retained:
			'The date list could not be refreshed. Showing the last list loaded here; its publication details are below.',
		first: 'First date',
		last: 'Latest date',
		metric: 'Metric group',
		gaps: 'Missing days',
		aggregation: 'Combining days',
		published: 'Date list published',
		method: 'Date-list method',
		generation: 'Published edition',
		scroll: (family: string) => `${family}: published metric history (scroll horizontally)`,
		details: 'Data health: full record-family inventory',
	},
	fr: {
		title: 'Historique publié',
		question: 'Jusqu’où remontent ces mesures ?',
		intro:
			'Voici les dates publiées pour chaque groupe de mesures et dimension\u00a0: le réseau entier, les lignes ou les arrêts. Elles ne garantissent pas que chaque mesure, ligne ou arrêt possède des données sur toute cette période.',
		limits:
			'Les groupes additifs combinent leurs décomptes sous-jacents sur plusieurs jours; il ne s’agit pas de faire la moyenne des pourcentages quotidiens. Les valeurs quotidiennes restent distinctes. En particulier, les centiles quotidiens ne peuvent être moyennés ni regroupés pour obtenir le centile d’une autre période.',
		unknown: 'Non publié',
		noList:
			'La liste des dates historiques n’est pas publiée. La profondeur disponible est inconnue, et non nulle.',
		noInventory:
			'Aucun inventaire historique par groupe de mesures n’est publié pour cette dimension. Cela ne signifie pas zéro historique.',
		noGaps: 'Aucun jour manquant déclaré',
		unknownGaps: 'Jours manquants non publiés',
		retained:
			'La liste des dates n’a pas pu être actualisée. Voici la dernière liste chargée ici; ses détails de publication figurent ci-dessous.',
		first: 'Première date',
		last: 'Dernière date',
		metric: 'Groupe de mesures',
		gaps: 'Jours manquants',
		aggregation: 'Combinaison des jours',
		published: 'Liste des dates publiée',
		method: 'Méthode de la liste',
		generation: 'Édition publiée',
		scroll: (family: string) =>
			`${family}\u00a0: historique des mesures publié (défilement horizontal)`,
		details: 'Santé des données\u00a0: inventaire complet des familles',
	},
});
