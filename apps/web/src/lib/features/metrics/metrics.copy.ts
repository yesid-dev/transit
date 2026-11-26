import { defineCopy, type Locale } from '#lib/i18n/copy.ts';
import { metricInfoCopy } from '#lib/metrics.ts';
import { articleCopy } from '#lib/components/layout/articleCopy.ts';
import type { SurfaceHeadCopy } from '#lib/components/surface/index.ts';

export const metricsCopy = defineCopy({
	fr: {
		questions: {
			provenance: 'D’où viennent les chiffres, et que comptent-ils ?',
			positions: 'Où est le véhicule entre deux relevés ?',
			gaps: 'Qu’est-ce que ces chiffres ne peuvent pas dire ?',
		},
		kicker: 'Méthode · science des mesures',
		heading: 'Comment on mesure',
		lede: 'Chaque chiffre de fiabilité dans cette archive est une estimation dérivée des prévisions en temps réel, et non une mesure certifiée. Voici, pour chaque indicateur, ce qu’il mesure vraiment, le calcul exact, le SQL, ce qu’il n’est pas et ses limites.',
		sections: {
			definition: 'Définition',
			math: 'Le calcul',
			sql: 'Le SQL',
			notReally: 'Ce que ce n’est pas',
			caveats: 'Limites',
			pipelineNote: 'Note sur les données actuelles',
		},
		provenance: {
			label: 'Sources et populations',
			body: 'Les mesures dérivent des horaires GTFS, des prévisions GTFS-RT, des positions de véhicules et des avis. Les statistiques historiques de retard comptent des observations, y compris les mises à jour répétées. En direct, la ponctualité et la couverture décrivent les positions admissibles sur la carte; les centiles donnent le même poids au retard moyen de chaque trajet. Les définitions précisent la population et la période de chaque indicateur. Ces données ne mesurent pas directement les arrivées aux arrêts ni le nombre d’usagers. Un dénominateur absent reste inconnu.',
			unavailable:
				'La vérification de conformité du flux n’a pas pu être chargée pour l’instant. Les définitions ci-dessous restent disponibles.',
			howWeMeasure: {
				label: 'Comment on mesure (vaut pour chaque indicateur)',
				serviceDay: {
					heading: 'Jour de collecte ou jour de service',
					body: 'Les résumés historiques de retard utilisent le jour local de collecte du fournisseur. Les comptes et plages de service gardent le jour de service GTFS. Les heures d’horaire peuvent dépasser 24:00\u00a0: ce sont des durées écoulées depuis midi local moins 12 heures. Les mesures en direct décrivent les données actuelles; chaque famille conserve sa propre période et ses limites.',
				},
				confidenceInterval: {
					heading: 'Lire un intervalle de confiance',
					body: 'La méthode de Wilson vise une couverture d’environ 95\u00a0% sur des échantillons répétés, avec des observations indépendantes et une probabilité de ponctualité stable. Les mises à jour d’un même trajet peuvent être corrélées. Ces intervalles ne corrigent pas cette dépendance et peuvent sous-estimer l’incertitude.',
					link: metricInfoCopy.confidenceIntervalLink.fr,
					reference: 'Intervalle de Wilson\u00a0: référence NIST',
				},
				rounding: {
					heading: 'Arrondi',
					body: 'À égalité exacte, les valeurs arrondies s’éloignent de zéro\u00a0: 2,55 devient 2,6 et −2,55 devient −2,6 à une décimale. Les fichiers archivés plus anciens peuvent utiliser un arrondi au pair. Les tranches du réseau en direct portent toujours sur les retards moyens par trajet arrondis à la minute.',
				},
				constants: {
					heading: 'Seuils retenus',
					body: (minN: string, wilsonZ: string) =>
						`Le seuil de fiabilité est fixé à ${minN} relevés à retard connu\u00a0: sous ce seuil, un taux conserve son nombre brut d’observations mais est signalé comme peu fiable, jamais supprimé. L’intervalle de confiance utilise le score de Wilson à 95\u00a0% (z = ${wilsonZ}). Ces deux valeurs proviennent directement des données publiées pour l’exécution en cours.`,
					absent:
						'Les seuils de l’exécution en cours (nombre minimal de relevés et facteur z de Wilson) n’ont pas pu être chargés pour l’instant; la méthodologie ci-dessous reste exacte.',
				},
			},
		},
		lacunes: {
			title: 'Lacunes structurelles',
			lede: 'Aussi honnêtes soient-ils, ces chiffres ont des angles morts qu’aucun calcul ne comble. Voici ce qu’ils ne peuvent pas dire à l’usager, nommé sans détour.',
			gaps: [
				{
					heading: 'La fiabilité n’est pas pondérée par les usagers',
					body: 'Chaque relevé compte pareil, qu’il vienne d’une ligne bondée ou d’un véhicule presque vide. Une ligne très achalandée en retard pèse autant qu’une ligne déserte en retard. Nous n’avons aucun flux de charge ou de fréquentation pour pondérer selon l’impact humain réel, donc un retard qui touche des centaines de personnes et un retard qui n’en touche presque aucune se valent dans le chiffre.',
				},
				{
					heading: 'Aucun temps réel pour les modes rapides qui n’en diffusent pas',
					body: 'Certains modes de transport rapide ne publient aucun flux GTFS temps réel. Pour eux, la fiabilité en direct (retards, occupation, non-réponse) n’existe pas dans nos données\u00a0: seul l’horaire est affiché. La fiabilité en direct sur ce site ne couvre donc que les modes de surface qui diffusent leur position; les autres montrent l’horaire seul.',
				},
				{
					heading: 'Par arrêt et par ligne, pas par déplacement (origine vers destination)',
					body: 'On mesure la fiabilité à un arrêt et sur une ligne, jamais la fiabilité d’un déplacement complet de l’origine à la destination. Les correspondances, le temps de bout en bout et le risque de rater une correspondance ne sont pas mesurés. Nous n’avons aucune matrice origine-destination ni donnée de bout en bout, donc un parcours fiable arrêt par arrêt peut quand même mal tourner une fois les correspondances enchaînées.',
				},
			],
		},
		livePositions: {
			title: 'Positions des véhicules en direct, presque en temps réel, pas en temps réel',
			lede: 'Sur la carte en direct, chaque véhicule est dessiné à partir du flux GTFS temps réel. Mais ce flux n’est pas continu\u00a0: voici, honnêtement, comment la carte décide où placer un véhicule entre deux relevés, et le choix que vous contrôlez avec le réglage « Positions ».',
			points: [
				{
					heading: 'Un relevé de position arrive seulement toutes les ~20 à 60 secondes',
					body: 'La position GPS d’un véhicule n’arrive pas en continu\u00a0: le flux publie un nouveau relevé seulement toutes les ~20 à 60 secondes, pas à chaque instant. Entre deux relevés, nous n’avons aucune mesure réelle de l’endroit où se trouve le véhicule. Tout ce qui s’affiche entre les relevés est donc soit l’ancienne position figée, soit une estimation, jamais une nouvelle mesure.',
				},
				{
					heading: '« Estimées » = on estime la position entre les relevés',
					body: 'En mode « Estimées », entre deux relevés nous estimons où le véhicule se trouve le plus probablement en le projetant vers l’avant le long de sa ligne, à la dernière vitesse qu’il a signalée. C’est une estimation bornée et décroissante\u00a0: on fait confiance à un relevé frais brièvement, puis on arrête d’inventer du déplacement, et le prochain relevé réel corrige la position. C’est une approximation, pas une mesure\u00a0: c’est plus fluide à regarder, mais ce n’est pas la vérité GPS.',
				},
				{
					heading: 'Un véhicule qui ne répond plus fige et porte un grand «\u00a0!\u00a0»',
					body: 'Si un véhicule n’a pas signalé sa position depuis un moment, on ne fait jamais semblant qu’il bouge encore. Il fige à son dernier emplacement connu et reçoit un grand «\u00a0!\u00a0» bien visible, pour que vous sachiez d’un coup d’œil que sa position n’est plus fraîche. On préfère un véhicule immobile honnête à un véhicule inventé en mouvement.',
				},
				{
					heading: '« Signalées » = uniquement les positions mesurées',
					body: 'En mode « Signalées » (le mode par défaut), on n’affiche que les positions réellement mesurées\u00a0: à chaque mise à jour du flux (~30\u00a0s), chaque véhicule passe directement à son dernier emplacement signalé, sans aucune estimation entre les deux. C’est plus saccadé, mais c’est la vérité non embellie\u00a0: chaque point est une vraie mesure, jamais une supposition.',
				},
				{
					heading: 'Pourquoi les deux modes',
					body: 'Le mode « Estimées » estime le déplacement entre les mises à jour du flux. Le mode « Signalées » affiche les positions rapportées. Vous pouvez changer de mode à tout moment.',
				},
			],
		},
		confidence: {
			label: 'Niveaux de confiance',
			levels: {
				proxy: {
					chip: 'estimation',
					meaning:
						'Une estimation dérivée du flux, et non une mesure certifiée. Tous les indicateurs de fiabilité sur cette page.',
				},
				medium: {
					chip: 'direct',
					meaning:
						'Un décompte ponctuel par véhicule tiré des données en direct, et non un agrégat.',
				},
			},
		},
		article: articleCopy('fr', {
			watermark: 'Méthode',
			tags: ['mesure', 'ponctualité', 'retards', 'calcul honnête', 'données ouvertes'],
		}),
		statRail: {
			label: 'En bref',
			provenance: {
				title: 'Provenance',
				unavailable: 'Vérification de conformité momentanément indisponible.',
			},
			coverage: {
				title: 'Couverture',
				metrics: 'indicateurs',
				families: 'familles',
			},
			freshness: { title: 'Fraîcheur' },
		},
		tocLabel: 'Aller à un indicateur',
		tocCounterPrefix: 'SEC',
		backToTop: 'Retour en haut',
		sqlAria: 'SQL définissant l’indicateur',
		tocPill: {
			open: 'Sommaire',
			title: 'Aller à un indicateur',
			close: 'Fermer le sommaire',
		},
		clusters: {
			punctuality: '01 Ponctualité',
			waitRegularity: '02 Régularité des attentes',
			serviceDelivered: '03 Service effectué',
			crowding: '04 Occupation',
			habits: '05 Habitudes horaires',
		},
		info: metricInfoCopy.fr,
	},
	en: {
		questions: {
			provenance: 'Where do the numbers come from, and what do they count?',
			positions: 'Where is the vehicle between reports?',
			gaps: 'What can these numbers not tell you?',
		},
		kicker: 'Methodology · metric science',
		heading: 'How we measure',
		lede: 'Every reliability number in this archive is an estimate derived from the predicted realtime feed, not a certified measurement. Here, for each measure, is what it actually measures, the exact math, the SQL, what it is not, and its honest limits.',
		sections: {
			definition: 'Definition',
			math: 'The math',
			sql: 'The SQL',
			notReally: 'What it is not',
			caveats: 'Caveats',
			pipelineNote: 'Current data note',
		},
		provenance: {
			label: 'Sources and populations',
			body: 'The measures derive from GTFS schedules, GTFS-RT predictions, vehicle positions and alerts. Historical delay statistics count observations, including repeated updates. Live punctuality and coverage describe map-eligible vehicle positions; live percentiles give each current trip-average delay equal weight. Each definition states its population and period. These data do not directly measure arrivals at stops or passenger counts. An unavailable denominator remains unknown.',
			unavailable:
				'The live feed-conformance check could not be loaded right now. The definitions below remain available.',
			howWeMeasure: {
				label: 'How we measure (applies to every measure)',
				serviceDay: {
					heading: 'Collection day vs service day',
					body: 'Historical delay summaries use the provider-local collection day. Service counts and spans retain the GTFS service day. Schedule times can exceed 24:00: they are elapsed durations from local noon minus 12 hours. Live measures describe the current live data; each family retains its own period and coverage limits.',
				},
				confidenceInterval: {
					heading: 'Reading a confidence interval',
					body: 'The Wilson method aims for about 95% coverage across repeated samples with independent observations and a stable on-time probability. Updates from the same trip can be correlated. These intervals do not adjust for that dependence and can understate uncertainty.',
					link: metricInfoCopy.confidenceIntervalLink.en,
					reference: 'Wilson interval: NIST reference',
				},
				rounding: {
					heading: 'Rounding',
					body: 'At an exact tie, rounded values move away from zero: 2.55 becomes 2.6 and −2.55 becomes −2.6 at one decimal place. Older archived files may use ties-to-even rounding. Live network histogram bins still classify trip-average delays rounded to whole minutes.',
				},
				constants: {
					heading: 'Thresholds used',
					body: (minN, wilsonZ) =>
						`The reliability threshold is ${minN} known-delay observations: below it, a rate keeps its raw observation count but is flagged low-confidence, never suppressed. The confidence interval uses the 95% Wilson score interval (z = ${wilsonZ}). Both values are read directly from the current published data, not hardcoded.`,
					absent:
						'The current run’s thresholds (minimum observations and Wilson z) could not be loaded right now, so their exact values are not shown here. The methodology below is still exact.',
				},
			},
		},
		lacunes: {
			title: 'Structural gaps',
			lede: 'Honest as these numbers are, they have blind spots no amount of math closes. Here is what they cannot tell the rider, named plainly.',
			gaps: [
				{
					heading: 'Reliability is NOT passenger-weighted',
					body: 'Every reading counts the same, whether it comes from a packed route or a near-empty vehicle. A delayed busy route counts exactly the same as a delayed near-empty one. We have no passenger-load or ridership feed to weight by real human impact, so a delay that hits hundreds of riders and one that hits almost nobody land identically in the number.',
				},
				{
					heading: 'No realtime for rapid-transit modes that do not broadcast it',
					body: 'Some rapid-transit modes publish no GTFS-realtime feed at all. For those modes, live reliability (delays, crowding, non-responding) does not exist in our data: only the schedule is shown. So live reliability on this site covers surface vehicles that broadcast their position; the rest show the schedule only.',
				},
				{
					heading: 'Stop-level and route-level, NOT journey (origin to destination)',
					body: 'We measure reliability per stop and per route, never the reliability of a full journey from origin to destination. Transfers, end-to-end trip time, and the risk of missing a connection are not measured. We have no origin-destination matrix and no journey-level data, so a trip that looks reliable stop by stop can still go wrong once the connections are chained together.',
				},
			],
		},
		livePositions: {
			title: 'Live vehicle positions, almost real-time, not real-time',
			lede: 'On the live map, every vehicle is drawn from the live GTFS-realtime feed. But that feed is not continuous: here, honestly, is how the map decides where to draw a vehicle between reports, and the choice you control with the “Positions” setting.',
			points: [
				{
					heading: 'Each vehicle reports its position only every ~20-60 seconds',
					body: 'A vehicle’s GPS position does not arrive continuously: the feed publishes a fresh report only every ~20-60 seconds, not every moment. Between reports we have no real measurement of where the vehicle is. So anything shown between reports is either the old position held still, or an estimate, never a new measurement.',
				},
				{
					heading: '“Estimated” = we estimate the position between reports',
					body: 'In “Estimated” mode, between reports we estimate where a vehicle most likely is by projecting it forward along its route at its last reported speed. It is a bounded, decaying estimate: we trust a fresh fix briefly, then stop inventing travel, and the next real report corrects it. It is an approximation, not a measurement. Said plainly: it is smoother to watch, but it is not GPS truth.',
				},
				{
					heading: 'A vehicle that has not reported in a while freezes and gets a big “!”',
					body: 'If a vehicle has not reported its position in a while, we never pretend it is still moving. It freezes at its last known spot and gets a big, visible “!” so you can tell at a glance that its position is no longer fresh. We would rather show an honest stationary vehicle than a faked moving one.',
				},
				{
					heading: '“Reported” = measured positions only',
					body: 'In “Reported” mode (the default), we show only positions that were actually measured: on every ~30 s feed update each vehicle jumps straight to its last reported location, with no estimation in between. It is choppier, but it is the unembellished truth: every dot is a real measurement, never a guess.',
				},
				{
					heading: 'Why both modes',
					body: '“Estimated” mode estimates motion between feed updates. “Reported” mode shows the reported positions. You can switch between them at any time.',
				},
			],
		},
		confidence: {
			label: 'Confidence levels',
			levels: {
				proxy: {
					chip: 'estimate',
					meaning:
						'A feed-derived estimate, not a certified measurement. All the reliability measures on this page.',
				},
				medium: {
					chip: 'direct',
					meaning: 'A point-in-time per-vehicle count from live data, not an aggregate.',
				},
			},
		},
		article: articleCopy('en', {
			watermark: 'Method',
			tags: ['measure', 'on-time', 'delays', 'honest math', 'open data'],
		}),
		statRail: {
			label: 'At a glance',
			provenance: {
				title: 'Provenance',
				unavailable: 'Conformance check momentarily unavailable.',
			},
			coverage: {
				title: 'Coverage',
				metrics: 'measures',
				families: 'families',
			},
			freshness: { title: 'Freshness' },
		},
		tocLabel: 'Jump to a measure',
		tocCounterPrefix: 'SEC',
		backToTop: 'Back to top',
		sqlAria: 'Defining SQL for the measure',
		tocPill: {
			open: 'Contents',
			title: 'Jump to a measure',
			close: 'Close contents',
		},
		clusters: {
			punctuality: '01 Punctuality',
			waitRegularity: '02 Wait regularity',
			serviceDelivered: '03 Service delivered',
			crowding: '04 Crowding',
			habits: '05 Time-of-day habits',
		},
		info: metricInfoCopy.en,
	},
}) satisfies Readonly<Record<Locale, SurfaceHeadCopy>>;
