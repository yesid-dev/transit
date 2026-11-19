import { defineCopy, type Locale } from '#lib/i18n/copy.ts';
import { historyCopy } from '#lib/components/surface/historyCopy.ts';
import type { LateFigures, VerdictCopy, VerdictSentenceArgs } from '#lib/v1/verdict.ts';
import { fmtLocalePct } from '#lib/utils/format.ts';

// Section 02 states the record answer's own measure, the share more than five minutes late, so
// the page never frames one fact both ways.
const predictionShare = {
	fr: ({ window, onTen, lateTen, hedge }: VerdictSentenceArgs) =>
		`Dans ce résumé ${window}, environ ${lateTen} prévisions connues sur 10 ont plus de cinq minutes de retard${hedge}\u00a0; environ ${onTen} sur 10 restent sous ce seuil.`,
	en: ({ window, onTen, lateTen, hedge }: VerdictSentenceArgs) =>
		`In this ${window}, about ${lateTen} in 10 known predictions are more than five minutes late${hedge}; about ${onTen} in 10 are not.`,
};
const lateFigure = (late: LateFigures, locale: Locale): string =>
	fmtLocalePct(late.pct, locale, { noData: '' });

export const stopReliabilityCopy = defineCopy({
	fr: {
		byRoute: 'Retard moyen par ligne',
		noRouteBreakdown: 'Aucun détail par ligne pour cet arrêt.',
		paneHeading: 'Prévisions de retard',
		metrics: {
			otp: 'Prévisions sans retard grave',
			avgDelay: 'Retard moyen',
			severe: 'Part des retards graves',
		},
		controlsLabel: 'Vue',
		nav: {
			toc: 'Aller à une section',
			pillOpen: 'Ouvrir la vue et les sections',
			pillClose: 'Fermer la vue et les sections',
		},
		grain: {
			label: 'Période de regroupement',
			day: 'Jour',
			week: 'Semaine',
			month: 'Mois',
			window: (grain: string) =>
				grain === 'week'
					? 'Regroupé par semaine.'
					: grain === 'month'
						? 'Regroupé par mois.'
						: 'Regroupé par jour.',
		},
		scope: {
			latestDay: 'Dernier jour complet',
			allHistory: (from: string, to: string) =>
				`Tout l’historique disponible : du ${from} au ${to}. Ces chiffres ne changent pas avec les dates choisies.`,
		},
		history: {
			navigator: historyCopy('fr', {
				mode: 'range',
				group: 'Historique de fiabilité de l’arrêt',
				picker: {
					group: 'Plage de dates',
					clear: 'Revenir au portrait actuel',
					anyStart: 'Première date',
					anyEnd: 'Dernière date',
				},
			}),
			coverage: (from: string, to: string) => `Historique disponible du ${from} au ${to}.`,
			selection: (from: string, to: string) => `Plage choisie : du ${from} au ${to}.`,
			correction: {
				malformed: 'La plage invalide a été remplacée par le portrait actuel.',
				'outside-coverage': 'La plage non disponible a été remplacée par le portrait actuel.',
				gap: 'La plage traverse une lacune dans les données conservées.',
				unpublished: 'La plage non publiée a été remplacée par le portrait actuel.',
			},
			partial: 'Cette plage ne couvre qu’une partie des mesures conservées.',
			currentOnly:
				'L’identité, les périodes, les habitudes, les jours, les heures et le détail par ligne restent basés sur le portrait actuel.',
			predictionScope:
				'Le verdict décrit la fenêtre choisie; les lignes du bilan restent celles du portrait actuel.',
			loading: 'Chargement de la plage conservée…',
			ready: 'Plage conservée chargée.',
			error: 'Impossible de charger cette plage conservée.',
			retry: 'Réessayer',
		},
		verdict: {
			windowPhrase: {
				day: 'quotidien',
				week: 'hebdomadaire',
				month: 'mensuel',
				range: 'de la plage choisie',
			},
			reliable: predictionShare.fr,
			patchy: predictionShare.fr,
			unreliable: predictionShare.fr,
			tentative: ({ window, n, late }) =>
				`Dans ce résumé ${window}, ${lateFigure(late, 'fr')} de ${n} prévisions connues ont plus de cinq minutes de retard. Bornes de Wilson nominales à 95\u00a0%\u00a0: ${late.lo}–${late.hi}\u00a0%\u00a0; les relevés peuvent être dépendants.`,
			unknownCount: () =>
				'Relevés insuffisants pour juger la fiabilité : nombre d’observations inconnu.',
			unavailableInterval: (window, n) =>
				`Ce résumé ${window} contient ${n} prévisions connues, mais aucune plage d’incertitude exploitable pour juger la fiabilité.`,
			tooFew: (window: string, n: number) =>
				`Ce résumé ${window} contient seulement ${n} prévisions connues admissibles.`,
			absent: 'Aucune prévision de retard admissible dans ce résumé.',
			hedgeCI: (_otp, _lo, _hi, late) =>
				` (${lateFigure(late, 'fr')}\u00a0; Wilson nominal à 95\u00a0%\u00a0: ${late.lo}–${late.hi}\u00a0%, relevés potentiellement dépendants)`,
		} satisfies VerdictCopy,
		percentiles: {
			heading: 'Retard habituel',
			typical: 'Retard médian',
			typicalCaption: 'Médiane des relevés de retard prédit',
			p90: 'Retard au 90e percentile',
			p90Caption: '90e percentile des relevés de retard prédit',
		},
		habits: {
			heading: 'Score relatif des retards graves par heure',
			label: 'Score relatif au sein de cet arrêt, par jour et par heure',
			cellValueLabel: 'Score relatif',
			hourAxisLabel: 'Heure de la journée',
			dayAxisLabel: 'Jour de la semaine',
			caption:
				'Les comptes de relevés de retard grave sont divisés par le plus grand compte de cet arrêt, toutes journées et heures confondues. ◆ encadre les scores de 0,75 à 1 de ce maximum. Zéro signifie qu’un score nul est fourni; une case vide est indisponible. Cette échelle compare les heures au sein de cet arrêt, sans mesurer la probabilité de retard d’un trajet.',
			legend: {
				tiers: [
					'Score relatif faible',
					'Score relatif modéré',
					'Score relatif élevé',
					'Score relatif très élevé',
				] as const,
			},
			weekdays: [
				'',
				'Lundi',
				'Mardi',
				'Mercredi',
				'Jeudi',
				'Vendredi',
				'Samedi',
				'Dimanche',
			] as const,
			weekdaysShort: ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'] as const,
		},
		weekday: {
			heading: 'Par jour de la semaine',
			avgDelay: 'Retard moyen',
			severeShare: 'Part des retards graves',
			caveat:
				'Estimation sur fenêtre glissante, pondérée par les observations, pas une ponctualité certifiée; les petits échantillons varient.',
		},
		timeOfDay: {
			heading: 'Par période de la journée',
			severeShare: 'Part des retards graves',
			dayType: 'Semaine vs fin de semaine',
			caveat:
				'Estimation sur fenêtre glissante, pondérée par les observations, pas une ponctualité certifiée; les petits échantillons varient.',
		},
		crowding: {
			heading: 'Encombrement des véhicules vus ici',
			window:
				'Répartition de l’occupation des véhicules observés à cet arrêt sur les 30 derniers jours, dans le réseau sélectionné. Ce n’est pas une caractéristique de l’arrêt.',
			barLabel: 'Répartition de l’occupation des véhicules observés à cet arrêt',
			dominantLabel: 'Occupation la plus fréquente',
		},
		dayByDay: {
			heading: 'Jour par jour',
			summary: (low: string, high: string, highDay: string) =>
				`Entre ${low} et ${high} selon le jour. Le plus élevé\u00a0: ${highDay}.`,
			summaryAbsent: 'Moins de 2 jours mesurés\u00a0: pas de comparaison jour par jour.',
			caption: (dates: string) =>
				`Relevés à plus de 5 minutes de retard chaque jour, ${dates}, en pourcentage`,
			hideTable: 'Masquer le tableau',
			tableCaption: (dates: string) => `Relevés à plus de 5 minutes de retard, ${dates}`,
			columns: {
				day: 'Jour',
				share: 'Part',
				readings: 'Relevés',
				late: 'Plus de 5 min de retard',
			},
			notPublished: 'Non publié',
			noReadings: 'Aucun relevé',
			scopeLabel: 'Limites de ces jours',
			basis: {
				record: (days: string) =>
					`Les ${days} mêmes jours que le bilan ci-dessus. Le bilan additionne leurs relevés; il ne fait pas la moyenne de ces parts quotidiennes.`,
				chosen: 'Les dates choisies. Le bilan ci-dessus reste la semaine publiée.',
				latest: (days: string) => `Les ${days} derniers jours du fichier de cet arrêt.`,
			},
			gaps: (gaps: number, shownGaps: string, shownDays: string) =>
				gaps === 1
					? `${shownGaps} de ces ${shownDays} jours n’a pas de part publiée. C’est une lacune, pas un zéro.`
					: `${shownGaps} de ces ${shownDays} jours n’ont pas de part publiée. Ce sont des lacunes, pas des zéros.`,
			noGaps: 'Chaque jour a une part publiée.',
			readings: (fewest: string, most: string) =>
				`Entre ${fewest} et ${most} relevés par jour. Une journée avec peu de relevés peut varier fortement.`,
			readingsSame: (count: number, shown: string) =>
				count === 1 ? `${shown} relevé chaque jour.` : `${shown} relevés chaque jour.`,
		},
		summaries: {
			percentiles: (p50: string, p90: string) =>
				`Médiane ${p50}; 9 relevés sur 10 à ${p90} ou moins.`,
			habits: 'Des nombres relatifs à cet arrêt, pas la probabilité d’un retard.',
			allHistory: 'Tout l’historique disponible, pas les dates choisies.',
			crowding: 'Sa propre période\u00a0: les 30 derniers jours.',
			byRoute: (count: number, shown: string) =>
				count === 1
					? 'Retard prévu moyen de la seule ligne.'
					: `Retard prévu moyen de chacune des ${shown} lignes.`,
		},
		showAllLines: (shown: string) => `Afficher les ${shown} lignes`,
		showFewerLines: 'Afficher moins de lignes',
		source: {
			heading: 'Source et méthode',
			summary: 'Ce qu’est un relevé et la publication de cet arrêt.',
			reading:
				'Un relevé est une prédiction communiquée, pas un trajet ou un passager. Les données disponibles n’expliquent pas la cause d’un retard.',
			built: 'Fichier de l’arrêt produit le',
			method: 'Version de la méthode',
			generation: 'Génération de publication',
			notSupplied: 'Non fourni dans ce fichier.',
			howWeMeasure: 'Comment on mesure',
		},
	},
	en: {
		byRoute: 'Avg delay by line',
		noRouteBreakdown: 'No per-line breakdown for this stop.',
		paneHeading: 'Predicted delays',
		metrics: {
			otp: 'Not-severe predictions',
			avgDelay: 'Average delay',
			severe: 'Severe-delay share',
		},
		controlsLabel: 'View',
		nav: {
			toc: 'Jump to a section',
			pillOpen: 'Open view and sections',
			pillClose: 'Close view and sections',
		},
		grain: {
			label: 'Roll-up period',
			day: 'Day',
			week: 'Week',
			month: 'Month',
			window: (grain) =>
				grain === 'week'
					? 'Rolled up by week.'
					: grain === 'month'
						? 'Rolled up by month.'
						: 'Rolled up by day.',
		},
		scope: {
			latestDay: 'Latest complete day',
			allHistory: (from, to) =>
				`All available history: ${from} to ${to}. These figures do not change with the selected dates.`,
		},
		history: {
			navigator: historyCopy('en', {
				mode: 'range',
				group: 'Stop reliability history',
				picker: {
					group: 'Date range',
					clear: 'Return to current snapshot',
					anyStart: 'First date',
					anyEnd: 'Last date',
				},
			}),
			coverage: (from, to) => `History available from ${from} to ${to}.`,
			selection: (from, to) => `Selected range: ${from} to ${to}.`,
			correction: {
				malformed: 'The invalid date range was replaced with the current snapshot.',
				'outside-coverage': 'The unavailable date range was replaced with the current snapshot.',
				gap: 'The selected range crosses a gap in retained data.',
				unpublished: 'The unpublished date range was replaced with the current snapshot.',
			},
			partial: 'This range has only partial retained metric coverage.',
			currentOnly:
				'Identity, periods, habits, weekday, time-of-day, and by-line detail still use the current snapshot.',
			predictionScope:
				'The verdict uses the selected window; summary rows still use the current snapshot.',
			loading: 'Loading retained range…',
			ready: 'Retained range loaded.',
			error: 'This retained range could not be loaded.',
			retry: 'Retry',
		},
		verdict: {
			windowPhrase: {
				day: 'daily summary',
				week: 'weekly summary',
				month: 'monthly summary',
				range: 'selected-range summary',
			},
			reliable: predictionShare.en,
			patchy: predictionShare.en,
			unreliable: predictionShare.en,
			tentative: ({ window, n, late }) =>
				`In this ${window}, ${lateFigure(late, 'en')} of ${n} known predictions are more than five minutes late. Nominal 95% Wilson bounds: ${late.lo}–${late.hi}%; readings may be dependent.`,
			unknownCount: () =>
				'Not enough delay observations to judge reliability: observation count unknown.',
			unavailableInterval: (window, n) =>
				`This ${window} contains ${n} known predictions, but no usable uncertainty range to judge reliability.`,
			tooFew: (window, n) => `This ${window} contains only ${n} eligible known predictions.`,
			absent: 'No eligible predicted-delay readings in this summary.',
			hedgeCI: (_otp, _lo, _hi, late) =>
				` (${lateFigure(late, 'en')}; nominal 95% Wilson: ${late.lo}–${late.hi}%, potentially dependent readings)`,
		} satisfies VerdictCopy,
		percentiles: {
			heading: 'Typical delay',
			typical: 'Median delay',
			typicalCaption: 'Median of reported predicted delays',
			p90: '90th-percentile delay',
			p90Caption: '90th percentile of reported predicted delays',
		},
		habits: {
			heading: 'Relative severe-delay score by hour',
			label: 'Relative score within this stop, by day and hour',
			cellValueLabel: 'Relative score',
			hourAxisLabel: 'Hour of day',
			dayAxisLabel: 'Day of week',
			caption:
				'Severe-delay reading counts are divided by this stop’s highest count across all days and hours. ◆ outlines scores from 0.75 to 1 of that maximum. Zero means a supplied zero score; blank cells are unavailable. This scale compares hours within this stop, without measuring a trip’s chance of delay.',
			legend: {
				tiers: [
					'Low relative score',
					'Moderate relative score',
					'High relative score',
					'Very high relative score',
				],
			},
			weekdays: ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
			weekdaysShort: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
		},
		weekday: {
			heading: 'By day of week',
			avgDelay: 'Avg delay',
			severeShare: 'Severe-delay share',
			caveat:
				'Trailing-window, observation-weighted estimate, not certified on-time; small samples vary.',
		},
		timeOfDay: {
			heading: 'By time of day',
			severeShare: 'Severe-delay share',
			dayType: 'Weekday vs weekend',
			caveat:
				'Trailing-window, observation-weighted estimate, not certified on-time; small samples vary.',
		},
		crowding: {
			heading: 'Crowding on vehicles seen here',
			window:
				'How full the vehicles observed at this stop ran over the last 30 days, in the selected network. This is not a property of the stop itself.',
			barLabel: 'Occupancy mix of vehicles observed at this stop',
			dominantLabel: 'Most common loading',
		},
		dayByDay: {
			heading: 'Day by day',
			summary: (low, high, highDay) => `Between ${low} and ${high} a day. Highest on ${highDay}.`,
			summaryAbsent: 'Fewer than 2 measured days: no day-by-day comparison.',
			caption: (dates) => `Readings more than 5 minutes late each day, ${dates}, in percent`,
			hideTable: 'Hide table',
			tableCaption: (dates) => `Readings more than 5 minutes late, ${dates}`,
			columns: {
				day: 'Day',
				share: 'Share',
				readings: 'Readings',
				late: 'More than 5 min late',
			},
			notPublished: 'Not published',
			noReadings: 'No readings',
			scopeLabel: 'Limits of these days',
			basis: {
				record: (days) =>
					`The same ${days} days as the record above. The record adds up their readings; it does not average these daily shares.`,
				chosen: 'The dates you chose. The record above stays the published week.',
				latest: (days) => `The latest ${days} days in this stop’s file.`,
			},
			gaps: (gaps, shownGaps, shownDays) =>
				gaps === 1
					? `${shownGaps} of these ${shownDays} days has no published share. It is a gap, not a zero.`
					: `${shownGaps} of these ${shownDays} days have no published share. They are gaps, not zeros.`,
			noGaps: 'Every day has a published share.',
			readings: (fewest, most) =>
				`Between ${fewest} and ${most} readings a day. A day with few readings can swing widely.`,
			readingsSame: (count, shown) =>
				count === 1 ? `${shown} reading each day.` : `${shown} readings each day.`,
		},
		summaries: {
			percentiles: (p50, p90) => `Median ${p50}; 9 in 10 readings at or below ${p90}.`,
			habits: 'Relative counts within this stop, not the chance of a delay.',
			allHistory: 'All available history, not the selected dates.',
			crowding: 'Its own period: the last 30 days.',
			byRoute: (count, shown) =>
				count === 1
					? 'Average predicted delay for the one line.'
					: `Average predicted delay for each of the ${shown} lines.`,
		},
		showAllLines: (shown) => `Show all ${shown} lines`,
		showFewerLines: 'Show fewer lines',
		source: {
			heading: 'Source and method',
			summary: 'What a reading is, and this stop’s publication.',
			reading:
				'One reading is one reported prediction, not one trip or passenger. The available data does not explain the cause of a delay.',
			built: 'Stop file built on',
			method: 'Method version',
			generation: 'Publication generation',
			notSupplied: 'Not supplied in this file.',
			howWeMeasure: 'How we measure',
		},
	},
}) satisfies Readonly<Record<Locale, { readonly verdict: VerdictCopy }>>;

export type StopReliabilityCopy = (typeof stopReliabilityCopy)[Locale];
