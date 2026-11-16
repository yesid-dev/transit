import { serviceComparisonCopy } from '#lib/v1/serviceComparison.ts';
import { defineCopy, type Locale } from '#lib/i18n/copy.ts';
import { historyCopy } from '#lib/components/surface/historyCopy.ts';
import type { VerdictCopy } from '#lib/v1/verdict.ts';
import { routeVerdictCopy } from './routeVerdict.copy';

/** A citation's parts, each already formatted by the caller for its locale. */
export interface CitationArgs {
	readonly host: string;
	readonly line: string;
	readonly provider: string;
	readonly figure: string;
	readonly dates: string;
	readonly readings: string | null;
	/** The published record's identity; each part only when the record supplies it. */
	readonly published: string | null;
	readonly generation: string | null;
	readonly method: string | null;
	readonly href: string;
}

/** "Record published …, generation …, method …." from the parts supplied, or nothing. */
function identity(parts: readonly (string | false | null)[]): string {
	const text = parts.filter(Boolean).join(', ');
	return text ? ` ${text.charAt(0).toUpperCase()}${text.slice(1)}.` : '';
}

export type ReliabilityClusterKey =
	| 'punctuality'
	| 'waitRegularity'
	| 'serviceDelivered'
	| 'crowding'
	| 'habits';

export const reliabilityCopy = defineCopy({
	fr: {
		csv: {
			displayed: 'CSV des lignes affichées',
			context: (label: string) => `CSV des lignes affichées : ${label}`,
		},
		clusters: {
			punctuality: 'Ponctualité',
			serviceDelivered: serviceComparisonCopy.fr.section,
			crowding: 'Encombrement',
			waitRegularity: 'Régularité des attentes',
			habits: 'Habitudes horaires',
		},
		strip: {
			notPublished: 'Non publié pour cette fenêtre',
			snapshotLabel: 'Aperçu de la fiabilité',
			otpPct: 'Ponctualité',
			target: 'Cible',
			avgDelayMin: 'Retard moyen',
			p50Min: 'Retard médian',
			p90Min: 'Retard au 90e percentile',
			headwayRegularityCov: 'Régularité (CV)',
			cancellationRatePct: "Taux d'annulation",
			skippedStopRatePct: "Taux d'arrêts ignorés",
			serviceCompletenessPct: serviceComparisonCopy.fr.label,
			serviceCompletenessFraction: serviceComparisonCopy.fr.fraction,
			p50Caption: 'Médiane des relevés de retard prédit',
			p90Caption: '90e percentile des relevés de retard prédit',
			p50EstimatedCaption: 'Médiane estimée des relevés de retard prédit',
			p90EstimatedCaption: '90e percentile estimé des relevés de retard prédit',
			delayDistHeading: 'Retard médian et 90e percentile',
			delayDistLabel: 'Retard, de tôt à tard (min)',
			delayDistCount: 'Relevés',
			delayDistCaption:
				'L’aire de chaque barre représente le nombre de relevés dans cet intervalle de retard. Les intervalles ont des largeurs différentes : la hauteur indique la densité. Les traits marquent la médiane et le 90e percentile. Vue de -5 à +30 min.',
			percentileNudge:
				'Les estimations du retard médian et du 90e percentile sont indisponibles ici. Consultez une vue par semaine ou par mois.',
			severePct: 'Part des retards graves',
			severeCaption: 'Part des relevés à retard connu classés en retard grave',
			skippedStopCaption: 'Arrêts non desservis',
			wilsonBandCaption:
				'Bande ombrée : intervalle de Wilson à 95 %. Plus il est large, moins l’estimation est précise. Les relevés répétés d’un même trajet peuvent le rendre trop étroit. Pointillés : cible de 80 %.',
			regularity: {
				regular: 'Apparitions régulières',
				irregular: 'Apparitions irrégulières',
			},
		},
		windows: {
			trendByDay: 'Par jour',
			trendByTimeOfDay: 'Par moment de la journée',
			habits: 'Toutes les données accumulées',
			serviceSpan: (date: string | null) =>
				date ? `Dernière journée de service · ${date}` : 'Dernière journée de service',
		},
		peak: {
			heading: 'Par période de la journée',
			dayType: 'Semaine vs fin de semaine',
			dayOfWeekSevere: 'Part des retards graves',
			caveat:
				'Estimation sur fenêtre glissante, pondérée par les observations, pas une ponctualité certifiée; les petits échantillons varient.',
			weekday: 'Semaine',
			weekend: 'Fin de semaine',
			strip: {
				ariaLabel: 'Retards graves par période',
				mean: (value: string) => `Moyenne approx. des périodes affichées : ${value}`,
			},
		},
		byDow: {
			heading: 'Encombrement par jour de la semaine',
			caption:
				"Répartition de l'occupation pour chaque jour, du lundi au dimanche. Un jour sans télémétrie le dit clairement plutôt que d'inventer une barre.",
		},
		delayByCrowding: {
			heading: "Retard selon l'occupation",
			bandHeader: "Niveau d'occupation",
			typical: (p50: string) => `typique ${p50}`,
		},
		crosstab: {
			heading: 'Par période et type de jour',
			shiftHeader: 'Période',
			dayTypeHeader: 'Type de jour',
			caption:
				'Ponctualité (% à l’heure) par période de la journée et type de jour, sur une échelle fixe de 0 à 100 %. Une cellule avec moins de 30 observations est grisée; jamais un zéro inventé.',
			heatmapLabel: 'Ponctualité par période et type de jour',
			legend: {
				low: 'Faible (0–40 %)',
				mid: 'Moyenne (40–80 %)',
				high: 'Élevée (80–100 %)',
			},
			hottest: 'Meilleure ponctualité',
			obs: (n: number) => `n=${n}`,
			lowSample: 'moins de 30 observations',
		},
		serviceSpanTimeline: {
			heading: 'Premières apparitions de trajets',
			spanMetric: 'Écart entre premières captures',
			tripCount: 'Identifiants de trajet observés',
			ariaLabel: (first: string, last: string) =>
				`Premières captures des trajets, du premier relevé le plus tôt à ${first} au premier relevé le plus tard à ${last}`,
			firstTrip: 'Premier relevé le plus tôt',
			lastTrip: 'Premier relevé le plus tard',
			span: (len: string) => `Écart arrondi ${len}`,
			trips: (n: string) => `${n} identifiants de trajet observés`,
			firstDelay: 'Premier trajet : retard du premier relevé',
			lastDelay: 'Dernier trajet : retard du dernier relevé',
			caption:
				'Les extrémités marquent des premières captures. Les dates locales et décalages UTC accompagnent un axe en heures écoulées; l’écart affiché s’arrondit à la minute. Les retards viennent du premier relevé du premier trajet et du dernier relevé du dernier trajet, qui peut être postérieur à l’extrémité droite.',
		},
		units: { pct: '%', min: ' min' },
		controls: {
			viewLabel: 'Vue',
			grainLabel: 'Granularité',
			latestDay: 'Dernier jour complet',
			closedSpan: (from: string, to: string) => `du ${from} au ${to}`,
			thisWeek: '7 derniers jours',
			thisMonth: '30 derniers jours',
			dateRange: 'Plage de dates',
			clearDates: 'Effacer les dates',
			rangeStart: 'Du',
			rangeEnd: 'Au',
			activeWindow: {
				unavailable: 'Fenêtre complète non publiée',
				day: (date: string | null) =>
					date
						? `Bilan des retards : jour local de capture ${date}. Les comptes et les plages de service suivent les jours de service GTFS.`
						: 'Jour de capture des retards indisponible. Les autres mesures conservent leurs propres fenêtres.',
				week: 'Fenêtre : cette semaine (semaine la plus récente)',
				month: 'Fenêtre : ce mois-ci (mois le plus récent)',
				singleDay: (date: string) => `Fenêtre : ${date}`,
				range: (n: number, start: string, end: string) =>
					`Moyenne sur ${n} ${n === 1 ? 'jour' : 'jours'}, du ${start} au ${end}`,
				rangeSelection: (start: string, end: string) => `Fenêtre : du ${start} au ${end}`,
				rangePrompt: 'Fenêtre : choisissez une date de début et de fin',
			},
			toc: 'Aller à une section',
			filterPillOpen: 'Ouvrir les commandes de vue',
			filterPillClose: 'Fermer les commandes de vue',
			tocPillClose: 'Fermer la liste des sections',
		},
		history: {
			navigator: historyCopy('fr', {
				mode: 'range',
				group: 'Historique de fiabilité de la ligne',
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
				'Les habitudes, les attentes, les pires arrêts et les associations restent basés sur le portrait actuel.',
			headerCurrentOnly: routeVerdictCopy.fr.history.headerCurrentOnly,
			loading: 'Chargement de la plage conservée…',
			ready: 'Plage conservée chargée.',
			error: 'Impossible de charger cette plage conservée.',
			retry: 'Réessayer',
		},
		sections: {
			verdict: {
				label: 'Fiabilité',
				question: 'Peut-on compter sur cette ligne ?',
				terminal: { title: 'verdict', tag: 'FIABILITÉ' },
			},
			whenToRide: { label: 'Selon l’heure de la journée' },
			theWait: { label: 'Attente et intervalles' },
			runAndFit: { label: 'Trajets annulés et manquants' },
			worstStops: { label: 'Arrêts touchés par des retards' },
			crowding: { label: 'Occupation' },
			detailShow: 'Voir le détail',
			detailHide: 'Masquer le détail',
		},
		evidence: {
			scope: (dates: string) => `Période de ces données : ${dates}.`,
			history: 'tout l’historique disponible',
			notPublished: 'Non publié pour cette période',
			summaryAbsent: 'Non publié pour cette période.',
			readings: (shown: string, count: number) => `${shown} ${count === 1 ? 'relevé' : 'relevés'}`,
			timeOfDay: {
				summary: (low: string, high: string, lowest: string) =>
					`Entre ${low} et ${high} selon la période de la journée. Le plus bas : ${lowest}.`,
				summaryOne: (period: string, share: string) =>
					`${period} : ${share} des relevés à l’heure.`,
				absentRange:
					'Les retards selon l’heure ne sont pas encore publiés pour une période choisie.',
				caption: 'Relevés à l’heure selon la période de la journée',
				columns: { period: 'Période', onTime: 'À l’heure', readings: 'Relevés' },
				dayType: 'Type de jour',
				and: ' et ',
				periods: {
					am_peak: 'Pointe du matin',
					midday: 'Mi-journée',
					pm_peak: 'Pointe de l’après-midi',
					evening: 'Soirée',
					night: 'Nuit',
					weekday: 'Jours de semaine',
					weekend: 'Fins de semaine',
				} as Record<string, string>,
				pattern: 'Profil par heure, tout l’historique disponible',
				patternNote:
					'Un score composite comparé seulement à l’intérieur de cette ligne. Ce n’est ni un taux de retard ni un classement entre lignes, et il ne change pas avec les dates choisies.',
			},
			stops: {
				summary: (stop: string, share: string) =>
					`${stop} a la part la plus élevée : ${share} de ses relevés avaient plus de 5 minutes de retard.`,
				lead: 'Part des relevés en retard de plus de 5 minutes, par arrêt.',
				order:
					'Le classement publié a retenu ces arrêts en tenant compte de l’incertitude. Ils sont listés ici selon leur part.',
				valueNote: ' des relevés avec plus de 5 minutes de retard',
				readingsAbsent: 'Relevés non publiés',
				showAll: (count: string) => `Voir les ${count} arrêts`,
				showFewer: 'Voir moins d’arrêts',
				absentRange: 'Les retards par arrêt ne sont pas encore publiés pour une période choisie.',
			},
			trips: {
				summary: (cancelled: string, seen: string, share: string) =>
					`${cancelled} des ${seen} trajets vus dans les données en direct ont été signalés annulés (${share}).`,
				cancelled: 'Trajets annulés',
				cancelledValue: (cancelled: string, seen: string, share: string) =>
					`${cancelled} sur ${seen} (${share})`,
				cancelledDef: (dates: string, seen: string) =>
					`Trajets vus dans les données en direct que la société de transport a signalés comme annulés, ${dates}. Les ${seen} trajets sont ceux apparus dans les données en direct, pas tous les trajets prévus.`,
				coverage: (days: string, of: string) => `Publié pour ${days} de ces ${of} jours.`,
				missing: 'Trajets manquants',
				missingDef:
					'Prévus pendant une journée terminée, jamais vus dans les données en direct et non annoncés comme annulés.',
				silent: 'Trajets silencieux',
				silentValue: 'Comptés en direct seulement.',
				seeLive: 'Voir en direct',
				silentDef: 'Prévus en ce moment, mais aucun véhicule ne se signale.',
				skipped: 'Arrêts sautés',
				skippedValue: (skipped: string, updates: string, share: string) =>
					`${skipped} des ${updates} mises à jour d’arrêt (${share})`,
				skippedDef:
					'Chaque trajet envoie de nombreuses mises à jour d’arrêt. On compte des mises à jour, pas des arrêts physiques.',
				note: 'Des rapports absents des données en direct peuvent cacher des trous dans le service.',
			},
			gaps: {
				summary:
					'Le temps d’attente n’est pas mesuré ici. Ce sont des intervalles entre les premiers relevés, pas entre les passages à votre arrêt.',
				caption: 'Intervalle médian en minutes, selon la période de la journée.',
				scheduled: 'Prévu',
				firstReports: 'Entre premiers relevés',
				definition:
					'Le premier relevé est le moment où un trajet apparaît pour la première fois dans les données en direct. Aucune des deux colonnes n’indique votre temps d’attente.',
				absentRange: 'Les intervalles ne sont pas encore publiés pour une période choisie.',
				frequentTitle: 'Service fréquent',
				frequent:
					'Les périodes considérées comme fréquentes viendront d’une classification publiée. Transit ne la devine jamais à partir du nom d’une ligne ni d’une seule période de l’horaire.',
			},
			crowding: {
				summary: (band: string, share: string) => `${band} dans ${share} des relevés d’occupation.`,
				absent: 'Aucune donnée d’occupation pour ce bilan.',
				absentBody:
					'L’information sur l’occupation n’est pas disponible pour cette ligne et cette période.',
				note: 'Parts des relevés d’occupation, pas des autobus ni des usagers. Elles ne garantissent pas une place.',
			},
		},
		record: {
			period: (dates: string, days: string) =>
				`${dates.charAt(0).toUpperCase()}${dates.slice(1)}, ${days}`,
			answerAfter: ' des relevés étaient à l’heure.',
			band: 'À l’heure : d’une minute d’avance à moins de 5 minutes de retard.',
			classification: {
				reliable: 'Classification de Transit : ponctualité fiable.',
				uneven: 'Classification de Transit : ponctualité inégale.',
				unreliable: 'Classification de Transit : ponctualité peu fiable.',
				uncertain: 'Classification de Transit : incertaine pour ces relevés.',
				'too-few': 'Pas assez de relevés pour juger.',
			},
			absent: 'Aucune part de relevés à l’heure n’est publiée pour cette période.',
			readings: (shown: string, count: number) =>
				`Selon ${shown} ${count < 2 ? 'relevé' : 'relevés'}.`,
			readingsNote: 'Ce ne sont ni des trajets ni des passagers.',
			readingsAbsent: 'Nombre de relevés non publié pour ce résultat.',
			comparison: (days: number, shown: string) =>
				days === 1
					? 'Aucune comparaison avec la journée précédente n’est encore publiée pour cette ligne.'
					: `Aucune comparaison avec les ${shown} jours précédents n’est encore publiée pour cette ligne.`,
			interval: (lo: string, hi: string) => `Intervalle d’incertitude\u00a0: de ${lo} à ${hi}.`,
			intervalNote:
				'Les relevés répétés d’un même trajet peuvent rendre cet intervalle trop étroit.',
			intervalAbsent: 'Intervalle d’incertitude : non disponible pour ce résultat.',
			linkCopied: 'Lien copié',
			citeCopied: 'Citation copiée',
			copyFallback: 'Copiez ce texte :',
			citation: (a: CitationArgs) =>
				`Transit (${a.host}). Ligne ${a.line}, ${a.provider}\u00a0: ${a.figure} des relevés à l’heure, ${a.dates}, ${a.readings == null ? 'nombre de relevés non publié' : `selon ${a.readings} relevés`}.${identity([a.published && `bilan publié le ${a.published}`, a.generation && `génération ${a.generation}`, a.method && `méthode ${a.method}`])} ${a.href}`,
			daily: {
				title: 'Jour par jour',
				summary: (low: string, high: string, lowDay: string) =>
					`Entre ${low} et ${high} selon le jour. Le plus bas\u00a0: ${lowDay}.`,
				summaryAbsent: 'Moins de 2 jours mesurés : pas de comparaison jour par jour.',
				caption: (dates: string) => `Relevés à l’heure chaque jour, ${dates}, en pourcentage`,
				reference: 'Ligne pointillée : seuil de classification de 80 % de Transit.',
				hideTable: 'Masquer le tableau',
				tableCaption: (dates: string) => `Relevés à l’heure et retard moyen, ${dates}`,
				columns: {
					day: 'Jour',
					onTime: 'À l’heure',
					readings: 'Relevés',
					avgDelay: 'Retard moyen',
				},
				gap: 'Non publié',
			},
			delays: {
				avg: 'Retard moyen',
				notPublished: 'Non publié pour cette période',
			},
		},
		verdict: routeVerdictCopy.fr.verdict,
	},
	en: {
		csv: {
			displayed: 'CSV of displayed rows',
			context: (label: string) => `CSV of displayed rows: ${label}`,
		},
		clusters: {
			punctuality: 'Punctuality',
			serviceDelivered: serviceComparisonCopy.en.section,
			crowding: 'Crowding',
			waitRegularity: 'Wait regularity',
			habits: 'Time-of-day habits',
		},
		strip: {
			notPublished: 'Not published for this window',
			snapshotLabel: 'Reliability snapshot',
			otpPct: 'On-time',
			target: 'Target',
			avgDelayMin: 'Avg delay',
			p50Min: 'Median delay',
			p90Min: '90th-percentile delay',
			headwayRegularityCov: 'Regularity (CoV)',
			cancellationRatePct: 'Cancellation rate',
			skippedStopRatePct: 'Skipped-stop rate',
			serviceCompletenessPct: serviceComparisonCopy.en.label,
			serviceCompletenessFraction: serviceComparisonCopy.en.fraction,
			p50Caption: 'Median of reported predicted delays',
			p90Caption: '90th percentile of reported predicted delays',
			p50EstimatedCaption: 'Estimated median of reported predicted delays',
			p90EstimatedCaption: 'Estimated 90th percentile of reported predicted delays',
			delayDistHeading: 'Median and 90th-percentile delay',
			delayDistLabel: 'Delay, early to late (min)',
			delayDistCount: 'Observations',
			delayDistCaption:
				'Each bar’s area represents the number of observations in that delay range. Bins have different widths, so height shows density. Reference lines mark the median and 90th percentile. View: -5 to +30 min.',
			percentileNudge:
				'Median and 90th-percentile delay estimates are unavailable here. Check a week or month view.',
			severePct: 'Severe-delay share',
			severeCaption: 'Share of known-delay readings classified as severe',
			skippedStopCaption: "Stops the vehicle didn't serve",
			wilsonBandCaption:
				'Shaded band: 95% Wilson interval. Wider means less precision; repeated updates from the same trip can make it too narrow. Dashed line: the 80% target.',
			regularity: {
				regular: 'Regular feed gaps',
				irregular: 'Irregular feed gaps',
			},
		},
		windows: {
			trendByDay: 'By day',
			trendByTimeOfDay: 'By time of day',
			habits: 'All accrued data',
			serviceSpan: (date) => (date ? `Latest service day · ${date}` : 'Latest service day'),
		},
		peak: {
			heading: 'By time of day',
			dayType: 'Weekday vs weekend',
			dayOfWeekSevere: 'Severe-delay share',
			caveat:
				'Trailing-window, observation-weighted estimate, not certified on-time; small samples vary.',
			weekday: 'Weekday',
			weekend: 'Weekend',
			strip: {
				ariaLabel: 'Severe delay by time of day',
				mean: (value) => `Approx. mean of displayed shifts: ${value}`,
			},
		},
		byDow: {
			heading: 'Crowding by day of week',
			caption:
				'How occupancy splits on each day, Monday through Sunday. A day with no telemetry says so plainly instead of fabricating a bar.',
		},
		delayByCrowding: {
			heading: 'Delay by crowding',
			bandHeader: 'Crowding band',
			typical: (p50) => `typical ${p50}`,
		},
		crosstab: {
			heading: 'By shift and day type',
			shiftHeader: 'Shift',
			dayTypeHeader: 'Day type',
			caption:
				'On-time rate (%) by time of day and day type, on a fixed 0–100% scale. A cell with fewer than 30 observations is greyed out, never a fabricated zero.',
			heatmapLabel: 'On-time rate by shift and day type',
			legend: {
				low: 'Low (0–40%)',
				mid: 'Medium (40–80%)',
				high: 'High (80–100%)',
			},
			hottest: 'Best on-time rate',
			obs: (n) => `n=${n}`,
			lowSample: 'fewer than 30 observations',
		},
		serviceSpanTimeline: {
			heading: 'Trip first appearances',
			spanMetric: 'First-report span',
			tripCount: 'Trip IDs observed',
			ariaLabel: (first, last) =>
				`First captured trip reports, from the earliest at ${first} to the latest at ${last}`,
			firstTrip: 'Earliest first report',
			lastTrip: 'Latest first report',
			span: (len) => `Rounded span ${len}`,
			trips: (n) => `${n} trip IDs observed`,
			firstDelay: 'First trip: delay in earliest report',
			lastDelay: 'Last trip: delay in latest report',
			caption:
				'Both endpoints mark first captured reports. Local dates and UTC offsets accompany an elapsed-hour axis; the span label rounds to whole minutes. Delay markers use the first trip’s earliest report and the last trip’s latest report, which may follow the right endpoint.',
		},
		units: { pct: '%', min: ' min' },
		controls: {
			viewLabel: 'View',
			grainLabel: 'Granularity',
			latestDay: 'Latest complete day',
			closedSpan: (from, to) => `${from} to ${to}`,
			thisWeek: 'Last 7 days',
			thisMonth: 'Last 30 days',
			dateRange: 'Date range',
			clearDates: 'Clear dates',
			rangeStart: 'From',
			rangeEnd: 'To',
			activeWindow: {
				unavailable: 'Complete window not published',
				day: (date: string | null) =>
					date
						? `Delay summary: local capture day ${date}. Service counts and spans follow GTFS service days.`
						: 'Delay capture day unavailable. Other measures retain their own windows.',
				week: 'Window: this week (most recent week)',
				month: 'Window: this month (most recent month)',
				singleDay: (date) => `Window: ${date}`,
				range: (n, start, end) =>
					`Average across ${n} ${n === 1 ? 'day' : 'days'}, ${start} to ${end}`,
				rangeSelection: (start, end) => `Window: ${start} to ${end}`,
				rangePrompt: 'Window: pick a start and end date',
			},
			toc: 'Jump to a section',
			filterPillOpen: 'Open view controls',
			filterPillClose: 'Close view controls',
			tocPillClose: 'Close section list',
		},
		history: {
			navigator: historyCopy('en', {
				mode: 'range',
				group: 'Line reliability history',
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
				'Habits, wait regularity, worst stops, and associations still use the current snapshot.',
			headerCurrentOnly: routeVerdictCopy.en.history.headerCurrentOnly,
			loading: 'Loading retained range…',
			ready: 'Retained range loaded.',
			error: 'This retained range could not be loaded.',
			retry: 'Retry',
		},
		sections: {
			verdict: {
				label: 'Reliability',
				question: 'Can you count on this line?',
				terminal: { title: 'verdict', tag: 'RELIABILITY' },
			},
			whenToRide: { label: 'By time of day' },
			theWait: { label: 'Waiting and gaps' },
			runAndFit: { label: 'Cancelled and missing trips' },
			worstStops: { label: 'Stops with delays' },
			crowding: { label: 'Crowding' },
			detailShow: 'Show the detail',
			detailHide: 'Hide the detail',
		},
		evidence: {
			scope: (dates) => `Period of these figures: ${dates}.`,
			history: 'all available history',
			notPublished: 'Not published for this period',
			summaryAbsent: 'Not published for this period.',
			readings: (shown, count) => `${shown} ${count === 1 ? 'reading' : 'readings'}`,
			timeOfDay: {
				summary: (low, high, lowest) =>
					`Between ${low} and ${high} by period of the day. Lowest: ${lowest}.`,
				summaryOne: (period, share) => `${period}: ${share} of readings on time.`,
				absentRange: 'Delays by time of day are not yet published for a chosen period.',
				caption: 'Readings on time by period of the day',
				columns: { period: 'Period', onTime: 'On time', readings: 'Readings' },
				dayType: 'Day type',
				and: ' and ',
				periods: {
					am_peak: 'Morning peak',
					midday: 'Midday',
					pm_peak: 'Afternoon peak',
					evening: 'Evening',
					night: 'Night',
					weekday: 'Weekdays',
					weekend: 'Weekends',
				},
				pattern: 'Pattern by hour, all available history',
				patternNote:
					'A composite score compared only within this line. It is neither a delay rate nor a ranking across lines, and it does not change with the selected dates.',
			},
			stops: {
				summary: (stop, share) =>
					`${stop} has the highest share: ${share} of its readings were more than 5 minutes late.`,
				lead: 'Share of readings more than 5 minutes late, per stop.',
				order:
					'The published ranking chose these stops, taking uncertainty into account. They are listed here by their share.',
				valueNote: ' of readings more than 5 minutes late',
				readingsAbsent: 'Readings not published',
				showAll: (count) => `Show all ${count} stops`,
				showFewer: 'Show fewer stops',
				absentRange: 'Delays by stop are not yet published for a chosen period.',
			},
			trips: {
				summary: (cancelled, seen, share) =>
					`${cancelled} of the ${seen} trips seen in the live data were reported cancelled (${share}).`,
				cancelled: 'Cancelled trips',
				cancelledValue: (cancelled, seen, share) => `${cancelled} of ${seen} (${share})`,
				cancelledDef: (dates, seen) =>
					`Trips seen in the live data that the agency reported as cancelled, ${dates}. The ${seen} are trips that appeared in the live data, not every scheduled trip.`,
				coverage: (days, of) => `Published for ${days} of these ${of} days.`,
				missing: 'Missing trips',
				missingDef:
					'Scheduled on a completed day, never seen in the live data and not announced as cancelled.',
				silent: 'Silent trips',
				silentValue: 'Counted live only.',
				seeLive: 'See live now',
				silentDef: 'Scheduled now, but no vehicle is reporting.',
				skipped: 'Skipped stops',
				skippedValue: (skipped, updates, share) =>
					`${skipped} of ${updates} stop updates (${share})`,
				skippedDef: 'Each trip sends many stop updates. This counts updates, not physical stops.',
				note: 'Reports missing from the live data can hide gaps in service.',
			},
			gaps: {
				summary:
					'Waiting time is not measured here. These are gaps between first reports, not arrivals at your stop.',
				caption: 'Median gap in minutes, by period of the day.',
				scheduled: 'Scheduled',
				firstReports: 'Between first reports',
				definition:
					'A first report is the moment a trip first appears in the live data. Neither column is how long you waited.',
				absentRange: 'Gaps are not yet published for a chosen period.',
				frequentTitle: 'Frequent service',
				frequent:
					'Which periods count as frequent will come from a published classification. Transit never guesses it from a line’s name or from one schedule period.',
			},
			crowding: {
				summary: (band, share) => `${band} in ${share} of occupancy readings.`,
				absent: 'No crowding data for this record.',
				absentBody: 'Crowding information is not available for this line and period.',
				note: 'Shares of occupancy readings, not of buses or riders. They do not promise a seat.',
			},
		},
		record: {
			period: (dates, days) => `${dates}, ${days}`,
			answerAfter: ' of readings were on time.',
			band: 'On time: from 1 minute early to less than 5 minutes late.',
			classification: {
				reliable: 'Transit’s classification: reliable punctuality.',
				uneven: 'Transit’s classification: uneven punctuality.',
				unreliable: 'Transit’s classification: unreliable punctuality.',
				uncertain: 'Transit’s classification: uncertain for these readings.',
				'too-few': 'Not enough readings to judge.',
			},
			absent: 'No share of readings on time is published for this period.',
			readings: (shown, count) => `Based on ${shown} ${count === 1 ? 'reading' : 'readings'}.`,
			readingsNote: 'These are not trips or passengers.',
			readingsAbsent: 'Reading count not published for this result.',
			comparison: (days, shown) =>
				days === 1
					? 'No comparison with the previous day is published for this line yet.'
					: `No comparison with the previous ${shown} days is published for this line yet.`,
			interval: (lo, hi) => `Uncertainty range: ${lo} to ${hi}.`,
			intervalNote: 'Repeated readings from the same trip can make this range too narrow.',
			intervalAbsent: 'Uncertainty range: not available for this result.',
			linkCopied: 'Link copied',
			citeCopied: 'Citation copied',
			copyFallback: 'Copy this text:',
			citation: (a) =>
				`Transit (${a.host}). Line ${a.line}, ${a.provider}: ${a.figure} of readings on time, ${a.dates}, ${a.readings == null ? 'reading count not published' : `based on ${a.readings} readings`}.${identity([a.published && `record published ${a.published}`, a.generation && `generation ${a.generation}`, a.method && `method ${a.method}`])} ${a.href}`,
			daily: {
				title: 'Day by day',
				summary: (low, high, lowDay) => `Between ${low} and ${high} each day. Lowest on ${lowDay}.`,
				summaryAbsent: 'Fewer than 2 measured days: no day-by-day comparison.',
				caption: (dates) => `Readings on time each day, ${dates}, in percent`,
				reference: 'Dashed line: Transit’s 80% classification reference.',
				hideTable: 'Hide table',
				tableCaption: (dates) => `Readings on time and average delay, ${dates}`,
				columns: { day: 'Day', onTime: 'On time', readings: 'Readings', avgDelay: 'Average delay' },
				gap: 'Not published',
			},
			delays: {
				avg: 'Average delay',
				notPublished: 'Not published for this period',
			},
		},
		verdict: routeVerdictCopy.en.verdict,
	},
}) satisfies Readonly<Record<Locale, { readonly verdict: VerdictCopy }>>;

export type ReliabilityCopy = (typeof reliabilityCopy)[Locale];
