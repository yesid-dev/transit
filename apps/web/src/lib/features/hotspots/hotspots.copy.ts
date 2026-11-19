import { defineCopy, type Locale } from '#lib/i18n/copy.ts';
import { articleCopy } from '#lib/components/layout/articleCopy.ts';
import { endOnDate, historyCopy } from '#lib/components/surface/historyCopy.ts';
import type { SurfaceHeadCopy } from '#lib/components/surface/index.ts';

type Kind = 'route' | 'stop';

/** What the citation states; the caller formats each value for the page's language. */
export interface CitationParts {
	readonly provider: string | null;
	readonly subject: string;
	readonly share: string | null;
	readonly period: string | null;
	readonly readings: string;
	readonly published: string | null;
	readonly method: string;
	readonly url: string;
}

/**
 * Counts reach these sentences twice: `n` decides the grammar, `shown` is n formatted by the
 * caller for the page's language. Dates and percentages arrive already formatted.
 */
export const copy = defineCopy({
	fr: {
		kicker: 'RESPONSABILITÉ · POINTS CHAUDS',
		heading: 'Points chauds',
		article: articleCopy('fr', {
			watermark: 'Points chauds',
			tags: ['chauds', 'lignes', 'arrêts', 'retards graves'],
			sections: (count: number) => `${count} ${count === 1 ? 'section' : 'sections'}`,
		}),
		history: {
			navigator: historyCopy('fr', {
				mode: 'date',
				group: 'Parcourir l’historique conservé des points chauds',
				picker: {
					group: 'Historique des points chauds',
					clear: 'Données actuelles',
					anyStart: 'Première date',
					anyEnd: 'Dernière date',
					single: 'Date historique',
				},
			}),
			coverage: (first: string, last: string) =>
				`Historique disponible : du ${first} au ${endOnDate(last)}`,
			selection: (date: string) => `Date affichée : ${endOnDate(date)}`,
			correction: {
				malformed: 'Cette date n’était pas valide. Affichage des points chauds les plus récents.',
				'outside-coverage':
					'Cette date est hors de l’historique conservé. Affichage des points chauds les plus récents.',
				gap: 'Cette date tombe dans une lacune de publication. Affichage des points chauds les plus récents.',
				unpublished:
					'Cette journée n’a pas été publiée. Affichage des points chauds les plus récents.',
			},
		},
		purpose: 'Des lignes et des arrêts à examiner dans le bilan publié.',
		controls: 'Options du classement',
		kind: {
			label: 'Classer les lignes ou les arrêts',
			route: 'Lignes',
			stop: 'Arrêts',
		},
		period: {
			label: 'Jours complets du bilan',
			week: '7 jours',
			month: '30 jours',
			line: (range: string, days: string) => `${range}, ${days}.`,
			unknown: 'Les dates de cette période ne sont pas publiées.',
		},
		measure: 'Part des relevés en retard de plus de 5 minutes.',
		finding: {
			route: (identity: string) => `Ligne en tête du classement : ${identity}.`,
			stop: (identity: string) => `Arrêt en tête du classement : ${identity}.`,
			none: {
				route: 'Aucune ligne n’est classée pour ces dates.',
				stop: 'Aucun arrêt n’est classé pour ces dates.',
			},
			absent: {
				week: 'Le classement sur 7 jours n’est pas publié dans ce bilan.',
				month: 'Le classement sur 30 jours n’est pas publié dans ce bilan.',
			},
			invalid:
				'Ce classement n’a pas passé ses vérifications de cohérence; il n’est donc pas affiché.',
		},
		ranking: {
			heading: { route: 'Lignes', stop: 'Arrêts' },
			count: (
				kind: Kind,
				shown: [number, string],
				published: [number, string],
				eligible: [number, string] | null,
			) => {
				const line = kind === 'route';
				const noun = (n: number) =>
					line ? (n < 2 ? 'ligne' : 'lignes') : n < 2 ? 'arrêt' : 'arrêts';
				const agree = (n: number, word: string) => `${word}${line ? 'e' : ''}${n < 2 ? '' : 's'}`;
				const head = `${shown[1]} ${noun(shown[0])} ${agree(shown[0], 'affiché')}`;
				if (eligible == null)
					return `${head} sur ${published[1]} ${agree(published[0], 'publié')}. Le nombre ${line ? 'de lignes admissibles' : 'd’arrêts admissibles'} n’est pas publié.`;
				const total = `${head} sur ${eligible[1]} ${eligible[0] < 2 ? 'admissible' : 'admissibles'}.`;
				return published[0] < eligible[0]
					? `${total} Ce bilan publie les ${published[1]} ${agree(published[0], line ? 'premièr' : 'premier')}.`
					: total;
			},
			order:
				'L’ordre publié tient compte de l’incertitude. Deux positions voisines n’indiquent pas nécessairement une différence nette.',
			choose: 'Sélectionnez une ligne du classement pour lire les détails.',
			position: (position: string, total: string | null) =>
				total == null ? `Position ${position}` : `Position ${position} sur ${total}`,
			showAll: (kind: Kind, shown: string) =>
				kind === 'route'
					? `Afficher les ${shown} lignes publiées`
					: `Afficher les ${shown} arrêts publiés`,
			showFewer: (kind: Kind, shown: string) =>
				kind === 'route' ? `Afficher les ${shown} premières` : `Afficher les ${shown} premiers`,
			spokenMeasure: 'des relevés en retard de plus de 5 minutes',
			lateUnknown: 'Part en retard non publiée',
		},
		readings: (n: number, shown: string) => `${shown} ${n < 2 ? 'relevé' : 'relevés'}`,
		readingsUnknown: 'Nombre de relevés non publié',
		kindWord: { route: 'Ligne', stop: 'Arrêt' },
		evidence: {
			heading: 'Bilan sélectionné',
			observed: 'des relevés indiquaient un retard de plus de 5 minutes.',
			included: 'Relevés à la base de ce résultat',
			period: 'Période complète',
			stopId: (id: string) => `Identifiant de l’arrêt : ${id}`,
			unit: 'Ce sont des relevés, pas des trajets ni des passagers.',
			noComparison: 'Une différence nette avec la position suivante n’est pas établie ici.',
			noInterval:
				'Aucun intervalle d’incertitude pour cette part en retard n’est publié dans ce bilan.',
			method: (version: string) => `Version de la méthode : ${version}.`,
			methodUnknown: 'Version de la méthode non publiée.',
		},
		share: {
			linkCopied: 'Lien copié.',
			citationCopied: 'Citation copiée.',
			fallback:
				'Votre navigateur n’a pas permis la copie. Sélectionnez le texte ci-dessous pour le copier.',
			text: 'Texte à copier',
		},
		citation: (parts: CitationParts) =>
			[
				'Transit.',
				parts.provider == null ? null : `${parts.provider}.`,
				`${parts.subject} : ${parts.share == null ? 'part en retard non publiée' : `${parts.share} des relevés en retard de plus de 5 minutes`}${parts.period == null ? '' : `, ${parts.period}`}.`,
				`${parts.readings}.`,
				parts.published == null ? null : `Bilan publié ${parts.published}.`,
				parts.method,
				parts.url,
			]
				.filter((part) => part != null)
				.join(' '),
		exclusions: {
			heading: { route: 'Lignes non classées', stop: 'Arrêts non classés' },
			floor: 'Moins de 30 relevés',
			noLive: 'Aucune donnée en direct',
			noLiveLimit:
				'Les lignes sans données en direct sont exclues des taux, des dénombrements et des classements.',
			total: (kind: Kind, n: number, shown: string) =>
				`${shown} ${kind === 'route' ? (n < 2 ? 'ligne' : 'lignes') : n < 2 ? 'arrêt' : 'arrêts'}`,
			unknown: 'Total non publié.',
		},
		excluded: {
			title: 'Dossiers exclus publiés',
			complete: (kind: Kind, n: number, shown: string) =>
				kind === 'route'
					? `${shown} ${n < 2 ? 'ligne' : 'lignes'} sous le seuil de 30 relevés, toutes listées ci-dessous.`
					: `${shown} ${n < 2 ? 'arrêt' : 'arrêts'} sous le seuil de 30 relevés, tous listés ci-dessous.`,
			examples: (n: number, shown: string) =>
				`${shown} ${n < 2 ? 'exemple publié' : 'exemples publiés'}, chacun sous le seuil de 30 relevés. La liste complète et le total ne sont pas publiés.`,
			zero: {
				route: 'Aucune ligne n’est sous le seuil de 30 relevés pour ces dates.',
				stop: 'Aucun arrêt n’est sous le seuil de 30 relevés pour ces dates.',
			},
			unknown: {
				route: 'Aucune liste de lignes exclues n’est publiée pour ces dates.',
				stop: 'Aucune liste d’arrêts exclus n’est publiée pour ces dates.',
			},
			label: {
				route: 'Lignes exclues publiées',
				stop: 'Arrêts exclus publiés',
			},
		},
		method: {
			title: 'Comment ce classement fonctionne',
			summary:
				'Une position invite à examiner le service; elle ne prouve pas une différence nette.',
			engine:
				'Le classement conserve l’ordre du diffuseur. La part en retard affichée ne détermine pas à elle seule cet ordre.',
			definition:
				'Un relevé est une prédiction de retard enregistrée. Un trajet peut produire plusieurs relevés.',
			bounds:
				'Les bornes publiées du classement décrivent un autre indicateur. Elles ne sont pas représentées à côté de la part en retard.',
		},
	},
	en: {
		kicker: 'ACCOUNTABILITY · HOTSPOTS',
		heading: 'Hotspots',
		article: articleCopy('en', {
			watermark: 'Hotspots',
			tags: ['hotspots', 'lines', 'stops', 'severe delay'],
			sections: (count: number) => `${count} ${count === 1 ? 'section' : 'sections'}`,
		}),
		history: {
			navigator: historyCopy('en', {
				mode: 'date',
				group: 'Browse retained hotspots history',
				picker: {
					group: 'Hotspots history',
					clear: 'Current data',
					anyStart: 'Earliest date',
					anyEnd: 'Latest date',
					single: 'History date',
				},
			}),
			coverage: (first, last) => `History available: ${first} to ${endOnDate(last)}`,
			selection: (date) => `Showing date: ${endOnDate(date)}`,
			correction: {
				malformed: 'That date was not valid. Showing the latest hotspots.',
				'outside-coverage': 'That date is outside retained history. Showing the latest hotspots.',
				gap: 'That date falls in a publication gap. Showing the latest hotspots.',
				unpublished: 'That day was not published. Showing the latest hotspots.',
			},
		},
		purpose: 'Lines and stops to investigate in the published record.',
		controls: 'Ranking controls',
		kind: {
			label: 'Rank lines or stops',
			route: 'Lines',
			stop: 'Stops',
		},
		period: {
			label: 'Complete days in the record',
			week: '7 days',
			month: '30 days',
			line: (range, days) => `${range}, ${days}.`,
			unknown: 'The dates of this period are not published.',
		},
		measure: 'Share of readings more than 5 minutes late.',
		finding: {
			route: (identity) => `First-ranked line: ${identity}.`,
			stop: (identity) => `First-ranked stop: ${identity}.`,
			none: {
				route: 'No line ranks for these dates.',
				stop: 'No stop ranks for these dates.',
			},
			absent: {
				week: 'The 7-day ranking is not published in this record.',
				month: 'The 30-day ranking is not published in this record.',
			},
			invalid: 'This ranking failed its consistency checks, so it is not shown.',
		},
		ranking: {
			heading: { route: 'Lines', stop: 'Stops' },
			count: (kind, shown, published, eligible) => {
				const noun = (n: number) => `${kind === 'route' ? 'line' : 'stop'}${n === 1 ? '' : 's'}`;
				if (eligible == null)
					return `Showing ${shown[1]} of ${published[1]} published ${noun(published[0])}. The number of eligible ${noun(2)} is not published.`;
				const total = `Showing ${shown[1]} of ${eligible[1]} eligible ${noun(eligible[0])}.`;
				return published[0] < eligible[0]
					? `${total} This record publishes the first ${published[1]}.`
					: total;
			},
			order:
				'The published order accounts for uncertainty. Nearby positions do not necessarily show a clear difference.',
			choose: 'Select a row to read its evidence.',
			position: (position, total) =>
				total == null ? `Position ${position}` : `Position ${position} of ${total}`,
			showAll: (kind, shown) =>
				`Show all ${shown} published ${kind === 'route' ? 'lines' : 'stops'}`,
			showFewer: (_kind, shown) => `Show the first ${shown}`,
			spokenMeasure: 'of readings more than 5 minutes late',
			lateUnknown: 'Late share not published',
		},
		readings: (n, shown) => `${shown} ${n === 1 ? 'reading' : 'readings'}`,
		readingsUnknown: 'Reading count not published',
		kindWord: { route: 'Line', stop: 'Stop' },
		evidence: {
			heading: 'Selected record',
			observed: 'of readings indicated a delay of more than 5 minutes.',
			included: 'Readings behind this result',
			period: 'Complete period',
			stopId: (id) => `Stop ID: ${id}`,
			unit: 'These are readings, not trips or passengers.',
			noComparison: 'A clear difference from the next position is not established here.',
			noInterval: 'An uncertainty range for this late share is not published in this record.',
			method: (version) => `Method version: ${version}.`,
			methodUnknown: 'Method version not published.',
		},
		share: {
			linkCopied: 'Link copied.',
			citationCopied: 'Citation copied.',
			fallback: 'Your browser did not allow copying. Select the text below to copy it.',
			text: 'Text to copy',
		},
		citation: (parts) =>
			[
				'Transit.',
				parts.provider == null ? null : `${parts.provider}.`,
				`${parts.subject}: ${parts.share == null ? 'late share not published' : `${parts.share} of readings more than 5 minutes late`}${parts.period == null ? '' : `, ${parts.period}`}.`,
				`${parts.readings}.`,
				parts.published == null ? null : `Record published ${parts.published}.`,
				parts.method,
				parts.url,
			]
				.filter((part) => part != null)
				.join(' '),
		exclusions: {
			heading: { route: 'Lines not ranked', stop: 'Stops not ranked' },
			floor: 'Fewer than 30 readings',
			noLive: 'No live data',
			noLiveLimit: 'Lines with no live data are excluded from rates, counts and rankings.',
			total: (kind, n, shown) =>
				`${shown} ${kind === 'route' ? 'line' : 'stop'}${n === 1 ? '' : 's'}`,
			unknown: 'Total not published.',
		},
		excluded: {
			title: 'Published excluded records',
			complete: (kind, n, shown) =>
				`${shown} ${kind === 'route' ? 'line' : 'stop'}${n === 1 ? '' : 's'} below the 30-reading floor, all listed below.`,
			examples: (n, shown) =>
				`${shown} published ${n === 1 ? 'example' : 'examples'}, each below the 30-reading floor. The complete list and total are not published.`,
			zero: {
				route: 'No line falls below the 30-reading floor for these dates.',
				stop: 'No stop falls below the 30-reading floor for these dates.',
			},
			unknown: {
				route: 'No excluded-line list is published for these dates.',
				stop: 'No excluded-stop list is published for these dates.',
			},
			label: {
				route: 'Published excluded lines',
				stop: 'Published excluded stops',
			},
		},
		method: {
			title: 'How this ranking works',
			summary: 'A position is a reason to investigate, not proof of a clear difference.',
			engine:
				'The ranking keeps the publisher’s order. The displayed late share alone does not determine that order.',
			definition:
				'One reading is one recorded delay prediction. A trip can produce several readings.',
			bounds:
				'The published ranking bounds describe a different measure. They are not drawn beside the late share.',
		},
	},
}) satisfies Readonly<Record<Locale, SurfaceHeadCopy>>;

export type HotspotsCopy = (typeof copy)[Locale];
