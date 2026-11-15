import { defineCopy, type Locale } from '#lib/i18n/copy.ts';
import { articleCopy } from '#lib/components/layout/articleCopy.ts';
import { historyCopy } from '#lib/components/surface/historyCopy.ts';
import type { SurfaceHeadCopy } from '#lib/components/surface/index.ts';
import type { UnrankedReason } from './selectors/offenderRanking';

type Kind = 'trip' | 'vehicle';

/** What the citation states; the caller formats each value for the page's language. */
export interface OffenderCitationParts {
	readonly provider: string | null;
	readonly subject: string;
	readonly lateDays: string;
	readonly period: string | null;
	readonly readings: string;
	readonly published: string | null;
	readonly method: string;
	readonly url: string;
}

/**
 * Counts reach these sentences twice: `n` decides the grammar, `shown` is n formatted by the
 * caller for the page's language. Dates, minutes and percentages arrive already formatted.
 */
export const copy = defineCopy({
	en: {
		departure: (line: string, time: string | null, headsign: string | null) =>
			`Line ${line}${time ? `, ${time}` : ''}${headsign ? ` toward ${headsign}` : ''}`,
		departureDetail: (time: string | null, headsign: string | null) =>
			[time, headsign ? `toward ${headsign}` : null].filter(Boolean).join(' '),
		onLine: (subject: string, line: string, name: string | null) =>
			`${subject} on line ${line}${name ? ` (${name})` : ''}`,
		kicker: 'ACCOUNTABILITY · REPEAT OFFENDERS',
		heading: 'Repeat offenders',
		article: articleCopy('en', {
			watermark: 'Repeat',
			tags: ['offenders', 'trips', 'vehicles', 'recurrence'],
			sections: (count: number) => `${count} ${count === 1 ? 'section' : 'sections'}`,
		}),
		history: {
			navigator: historyCopy('en', {
				mode: 'date',
				group: 'Browse retained repeat-offender history',
				picker: {
					group: 'Repeat-offender history',
					clear: 'Current data',
					anyStart: 'Earliest date',
					anyEnd: 'Latest date',
					single: 'History date',
				},
			}),
			coverage: (first, last) => `History available: ${first} to ${last}.`,
			selection: (date) => `Showing date: ${date}.`,
			correction: {
				malformed: 'That date was not valid. Showing the latest repeat offenders.',
				'outside-coverage':
					'That date is outside retained history. Showing the latest repeat offenders.',
				gap: 'That date falls in a publication gap. Showing the latest repeat offenders.',
				unpublished: 'That day was not published. Showing the latest repeat offenders.',
			},
		},
		purpose: 'Trips and buses that are late again and again in the published record.',
		controls: 'Ranking controls',
		kind: { label: 'Rank trips or buses', trip: 'Trips', vehicle: 'Buses' },
		period: {
			label: 'Complete days in the record',
			week: '7 days',
			month: '30 days',
			line: (range, days) => `${range}, ${days}.`,
			undated: (days) => `${days}. The dates of this period are not published.`,
			unknown: 'The dates of this period are not published.',
		},
		measure:
			'Ranked by late days, then by average delay. A late day has at least one reading more than 5 minutes late.',
		finding: {
			trip: (identity) => `First-ranked trip: ${identity}.`,
			vehicle: (identity) => `First-ranked bus: ${identity}.`,
			none: {
				trip: 'No trip meets the ranking rule for these dates.',
				vehicle: 'No bus meets the ranking rule for these dates.',
			},
			absent: {
				week: 'The 7-day ranking is not published in this record.',
				month: 'The 30-day ranking is not published in this record.',
			},
			invalid: 'This ranking failed its consistency checks, so it is not shown.',
		},
		earlierRule:
			'This record was published before the current ranking rule. Rows that do not meet it are listed as not ranked; ranked rows keep the publisher’s positions.',
		ranking: {
			heading: { trip: 'Trips', vehicle: 'Buses' },
			count: (
				kind: Kind,
				shown: [number, string],
				published: [number, string],
				eligible: [number, string] | null,
			) => {
				const noun = (n: number) =>
					`${kind === 'trip' ? 'trip' : 'bus'}${n === 1 ? '' : kind === 'trip' ? 's' : 'es'}`;
				if (eligible == null)
					return `Showing ${shown[1]} of ${published[1]} published ${noun(published[0])}. The number of eligible ${noun(2)} is not published.`;
				const total = `Showing ${shown[1]} of ${eligible[1]} eligible ${noun(eligible[0])}.`;
				return published[0] < eligible[0]
					? `${total} This record publishes the first ${published[1]}.`
					: total;
			},
			order:
				'Nearby positions do not necessarily show a clear difference. Each row is a reason to look closer.',
			choose: 'Select a row to read its evidence.',
			position: (position, total) =>
				total == null ? `Position ${position}` : `Position ${position} of ${total}`,
			showAll: (kind: Kind, shown: string) =>
				`Show all ${shown} published ${kind === 'trip' ? 'trips' : 'buses'}`,
			showFewer: (_kind: Kind, shown: string) => `Show the first ${shown}`,
		},
		lateDays: (late: number, seen: number, lateShown: string, seenShown: string) =>
			`Late on ${lateShown} of ${seenShown} ${seen === 1 ? 'day' : 'days'} seen`,
		lateDaysUnknown: 'Late days not published',
		averageDelay: (minutes: string) => `${minutes} average delay`,
		averageDelayUnknown: 'Average delay not published',
		readings: (n: number, shown: string) => `${shown} ${n === 1 ? 'reading' : 'readings'}`,
		readingsUnknown: 'Reading count not published',
		type: { trip: 'Trip', vehicle: 'Bus' },
		evidence: {
			heading: 'Selected record',
			figure: (late: string, seen: string) => `${late} of ${seen}`,
			lateDays: (_late: number, seen: number) =>
				`${seen === 1 ? 'day' : 'days'} seen had a reading more than 5 minutes late.`,
			averageDelay: 'Average delay',
			lateReadings: 'Readings more than 5 minutes late',
			lateShare: (late: string, readings: string, share: string) =>
				`${late} of ${readings} (${share})`,
			interval: 'Uncertainty range for that share',
			intervalValue: (lower: string, upper: string) => `${lower} to ${upper}`,
			notPublished: 'Not published in this record',
			readings: 'Readings',
			seen: 'Days seen in the period',
			seenValue: (seen: string, window: string) => `${seen} of ${window}`,
			period: 'Complete period',
			scope: {
				trip: 'A trip is one scheduled departure. A day counts only when the trip was seen running.',
				vehicle:
					'A bus is counted per line: a bus that served two lines has one row for each line.',
			},
			unit: 'Readings are recorded delay predictions, not passengers.',
			noComparison: 'A clear difference from the next position is not established here.',
			openLine: 'Open the line’s record',
			method: (version) => `Method version: ${version}.`,
			methodUnknown: 'Method version not published.',
		},
		share: {
			linkCopied: 'Link copied.',
			citationCopied: 'Citation copied.',
			fallback: 'Your browser did not allow copying. Select the text below to copy it.',
			text: 'Text to copy',
		},
		citation: (parts: OffenderCitationParts) =>
			[
				'Transit.',
				parts.provider == null ? null : `${parts.provider}.`,
				`${parts.subject}: ${parts.lateDays.charAt(0).toLowerCase()}${parts.lateDays.slice(1)}${parts.period == null ? '' : `, ${parts.period}`}.`,
				`${parts.readings}.`,
				parts.published == null ? null : `Record published ${parts.published}.`,
				parts.method,
				parts.url,
			]
				.filter((part) => part != null)
				.join(' '),
		exclusions: {
			heading: { trip: 'Trips not ranked', vehicle: 'Buses not ranked' },
			rule: 'A row ranks only with at least 30 readings, seen on at least 3 days and late on at least 2 of them.',
			total: {
				trip: 'The number of trips left out is not published.',
				vehicle: 'The number of buses left out is not published.',
			},
		},
		unranked: {
			title: 'Published rows not ranked',
			label: { trip: 'Published trips not ranked', vehicle: 'Published buses not ranked' },
			summary: (kind: Kind, n: number, shown: string, complete: boolean, belowRule: boolean) =>
				`${shown} published ${kind === 'trip' ? (n === 1 ? 'trip' : 'trips') : n === 1 ? 'bus' : 'buses'} ${belowRule ? 'below the rule' : 'not ranked'}.${complete ? '' : ' The record lists only part of them.'}`,
			none: {
				trip: 'This record lists no trip below the rule.',
				vehicle: 'This record lists no bus below the rule.',
			},
			reasons: {
				readings: 'Fewer than 30 readings.',
				observedDays: 'Seen on fewer than 3 days.',
				lateDays: 'Late on fewer than 2 days.',
				readingsUnknown: 'Reading count not published.',
				observedDaysUnknown: 'Days seen not published.',
				lateDaysUnknown: 'Late days not published.',
			} satisfies Record<UnrankedReason, string>,
			unexplained: 'Not ranked in this record.',
		},
		method: {
			title: 'How this ranking works',
			summary: 'A position is a reason to investigate, not proof of a clear difference.',
			order:
				'The ranking keeps the publisher’s order: more late days first, then the longer average delay. Days seen need not be consecutive.',
			definition:
				'One reading is one recorded delay prediction. A trip can produce several readings each day.',
			interval:
				'The uncertainty range belongs to the share of late readings. It does not decide the order.',
		},
	},
	fr: {
		departure: (line: string, time: string | null, headsign: string | null) =>
			`Ligne ${line}${time ? `, ${time}` : ''}${headsign ? ` vers ${headsign}` : ''}`,
		departureDetail: (time: string | null, headsign: string | null) =>
			[time, headsign ? `vers ${headsign}` : null].filter(Boolean).join(' '),
		onLine: (subject: string, line: string, name: string | null) =>
			`${subject} sur la ligne ${line}${name ? ` (${name})` : ''}`,
		kicker: 'REDDITION DE COMPTES · RÉCIDIVISTES',
		heading: 'Récidivistes',
		article: articleCopy('fr', {
			watermark: 'Récidive',
			tags: ['récidivistes', 'trajets', 'véhicules', 'récurrence'],
			sections: (count: number) => `${count} ${count === 1 ? 'section' : 'sections'}`,
		}),
		history: {
			navigator: historyCopy('fr', {
				mode: 'date',
				group: 'Parcourir l’historique conservé des récidivistes',
				picker: {
					group: 'Historique des récidivistes',
					clear: 'Données actuelles',
					anyStart: 'Première date',
					anyEnd: 'Dernière date',
					single: 'Date historique',
				},
			}),
			coverage: (first: string, last: string) => `Historique disponible : du ${first} au ${last}.`,
			selection: (date: string) => `Date affichée : ${date}.`,
			correction: {
				malformed: 'Cette date n’était pas valide. Affichage des récidivistes les plus récents.',
				'outside-coverage':
					'Cette date est hors de l’historique conservé. Affichage des récidivistes les plus récents.',
				gap: 'Cette date tombe dans une lacune de publication. Affichage des récidivistes les plus récents.',
				unpublished:
					'Cette journée n’a pas été publiée. Affichage des récidivistes les plus récents.',
			},
		},
		purpose: 'Des trajets et des bus en retard encore et encore dans le bilan publié.',
		controls: 'Options du classement',
		kind: { label: 'Classer les trajets ou les bus', trip: 'Trajets', vehicle: 'Bus' },
		period: {
			label: 'Jours complets du bilan',
			week: '7 jours',
			month: '30 jours',
			line: (range: string, days: string) => `${range}, ${days}.`,
			undated: (days: string) => `${days}. Les dates de cette période ne sont pas publiées.`,
			unknown: 'Les dates de cette période ne sont pas publiées.',
		},
		measure:
			'Classés selon les jours en retard, puis selon le retard moyen. Un jour en retard compte au moins un relevé en retard de plus de 5 minutes.',
		finding: {
			trip: (identity: string) => `Trajet en tête du classement : ${identity}.`,
			vehicle: (identity: string) => `Bus en tête du classement : ${identity}.`,
			none: {
				trip: 'Aucun trajet ne respecte la règle de classement pour ces dates.',
				vehicle: 'Aucun bus ne respecte la règle de classement pour ces dates.',
			},
			absent: {
				week: 'Le classement sur 7 jours n’est pas publié dans ce bilan.',
				month: 'Le classement sur 30 jours n’est pas publié dans ce bilan.',
			},
			invalid:
				'Ce classement n’a pas passé ses vérifications de cohérence; il n’est donc pas affiché.',
		},
		earlierRule:
			'Ce bilan a été publié avant la règle de classement actuelle. Les rangées qui ne la respectent pas figurent comme non classées; les rangées classées gardent les positions du diffuseur.',
		ranking: {
			heading: { trip: 'Trajets', vehicle: 'Bus' },
			count: (
				kind: Kind,
				shown: [number, string],
				published: [number, string],
				eligible: [number, string] | null,
			) => {
				const trip = kind !== 'vehicle';
				const noun = (n: number) => (trip ? (n < 2 ? 'trajet' : 'trajets') : 'bus');
				const agree = (n: number, word: string) => `${word}${n < 2 ? '' : 's'}`;
				const head = `${shown[1]} ${noun(shown[0])} ${agree(shown[0], 'affiché')}`;
				if (eligible == null)
					return `${head} sur ${published[1]} ${agree(published[0], 'publié')}. Le nombre de ${trip ? 'trajets' : 'bus'} admissibles n’est pas publié.`;
				const total = `${head} sur ${eligible[1]} ${eligible[0] < 2 ? 'admissible' : 'admissibles'}.`;
				return published[0] < eligible[0]
					? `${total} Ce bilan publie les ${published[1]} ${agree(published[0], 'premier')}.`
					: total;
			},
			order:
				'Deux positions voisines n’indiquent pas nécessairement une différence nette. Chaque rangée invite à regarder de plus près.',
			choose: 'Sélectionnez une rangée du classement pour lire les détails.',
			position: (position: string, total: string | null) =>
				total == null ? `Position ${position}` : `Position ${position} sur ${total}`,
			showAll: (kind: Kind, shown: string) =>
				kind !== 'vehicle'
					? `Afficher les ${shown} trajets publiés`
					: `Afficher les ${shown} bus publiés`,
			showFewer: (_kind: Kind, shown: string) => `Afficher les ${shown} premiers`,
		},
		lateDays: (late: number, seen: number, lateShown: string, seenShown: string) =>
			`En retard ${lateShown} ${late < 2 ? 'jour' : 'jours'} sur ${seenShown} ${seen < 2 ? 'observé' : 'observés'}`,
		lateDaysUnknown: 'Jours en retard non publiés',
		averageDelay: (minutes: string) => `${minutes} de retard moyen`,
		averageDelayUnknown: 'Retard moyen non publié',
		readings: (n: number, shown: string) => `${shown} ${n < 2 ? 'relevé' : 'relevés'}`,
		readingsUnknown: 'Nombre de relevés non publié',
		type: { trip: 'Trajet', vehicle: 'Bus' },
		evidence: {
			heading: 'Bilan sélectionné',
			figure: (late: string, seen: string) => `${late} sur ${seen}`,
			lateDays: (late: number, seen: number) =>
				`${seen < 2 ? 'jour observé' : 'jours observés'} ${late < 2 ? 'comptait' : 'comptaient'} un relevé en retard de plus de 5 minutes.`,
			averageDelay: 'Retard moyen',
			lateReadings: 'Relevés en retard de plus de 5 minutes',
			lateShare: (late: string, readings: string, share: string) =>
				`${late} sur ${readings} (${share})`,
			interval: 'Intervalle d’incertitude de cette part',
			intervalValue: (lower: string, upper: string) => `de ${lower} à ${upper}`,
			notPublished: 'Non publié dans ce bilan',
			readings: 'Relevés',
			seen: 'Jours observés dans la période',
			seenValue: (seen: string, window: string) => `${seen} sur ${window}`,
			period: 'Période complète',
			scope: {
				trip: 'Un trajet est un départ prévu à l’horaire. Un jour compte seulement si le trajet a été vu en service.',
				vehicle:
					'Un bus est compté par ligne : un bus qui a desservi deux lignes a une rangée pour chacune.',
			},
			unit: 'Les relevés sont des prédictions de retard enregistrées, pas des passagers.',
			noComparison: 'Une différence nette avec la position suivante n’est pas établie ici.',
			openLine: 'Ouvrir le bilan de la ligne',
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
		citation: (parts: OffenderCitationParts) =>
			[
				'Transit.',
				parts.provider == null ? null : `${parts.provider}.`,
				`${parts.subject} : ${parts.lateDays.charAt(0).toLowerCase()}${parts.lateDays.slice(1)}${parts.period == null ? '' : `, ${parts.period}`}.`,
				`${parts.readings}.`,
				parts.published == null ? null : `Bilan publié ${parts.published}.`,
				parts.method,
				parts.url,
			]
				.filter((part) => part != null)
				.join(' '),
		exclusions: {
			heading: { trip: 'Trajets non classés', vehicle: 'Bus non classés' },
			rule: 'Une rangée n’est classée qu’avec au moins 30 relevés, vue au moins 3 jours et en retard au moins 2 de ces jours.',
			total: {
				trip: 'Le nombre de trajets laissés de côté n’est pas publié.',
				vehicle: 'Le nombre de bus laissés de côté n’est pas publié.',
			},
		},
		unranked: {
			title: 'Rangées publiées non classées',
			label: { trip: 'Trajets publiés non classés', vehicle: 'Bus publiés non classés' },
			summary: (kind: Kind, n: number, shown: string, complete: boolean, belowRule: boolean) =>
				`${shown} ${kind !== 'vehicle' ? (n < 2 ? 'trajet publié' : 'trajets publiés') : n < 2 ? 'bus publié' : 'bus publiés'} ${belowRule ? 'sous la règle' : n < 2 ? 'non classé' : 'non classés'}.${complete ? '' : ' Le bilan n’en liste qu’une partie.'}`,
			none: {
				trip: 'Ce bilan ne liste aucun trajet sous la règle.',
				vehicle: 'Ce bilan ne liste aucun bus sous la règle.',
			},
			reasons: {
				readings: 'Moins de 30 relevés.',
				observedDays: 'Vu moins de 3 jours.',
				lateDays: 'En retard moins de 2 jours.',
				readingsUnknown: 'Nombre de relevés non publié.',
				observedDaysUnknown: 'Jours observés non publiés.',
				lateDaysUnknown: 'Jours en retard non publiés.',
			} satisfies Record<UnrankedReason, string>,
			unexplained: 'Non classé dans ce bilan.',
		},
		method: {
			title: 'Comment ce classement fonctionne',
			summary:
				'Une position invite à examiner le service; elle ne prouve pas une différence nette.',
			order:
				'Le classement conserve l’ordre du diffuseur : d’abord le plus de jours en retard, puis le retard moyen le plus long. Les jours observés ne sont pas nécessairement consécutifs.',
			definition:
				'Un relevé est une prédiction de retard enregistrée. Un trajet peut produire plusieurs relevés chaque jour.',
			interval:
				'L’intervalle d’incertitude porte sur la part des relevés en retard. Il ne décide pas de l’ordre.',
		},
	},
}) satisfies Readonly<Record<Locale, SurfaceHeadCopy>>;

export type RepeatOffendersCopy = (typeof copy)[Locale];
