import { defineCopy, type Locale } from '#lib/i18n/copy.ts';
import {
	NAV_GROUPS,
	visibleNav,
	YESID_HOUSE_LINK,
	type BilingualLabel,
	type NavGroupKey,
	type NavItem,
} from '#lib/content/nav.ts';

type CopyKey =
	| 'auditBody'
	| 'notPlanner'
	| 'auditMore'
	| 'readMore'
	| 'readLess'
	| 'audience'
	| 'cadence'
	| 'cadenceLive'
	| 'headline'
	| 'headlineAccent'
	| 'exploreNav';

export const homeCopy = defineCopy({
	fr: {
		auditBody:
			'Transit est un registre public et indépendant du service d’autobus que {city} reçoit réellement.',
		notPlanner: 'Ce n’est pas un planificateur de trajets.',
		auditMore:
			'Il montre à quelle fréquence les autobus du réseau {operator} sont en retard, de combien, et sur quelles lignes et à quels arrêts, à partir des données ouvertes de la société de transport.',
		readMore: 'En savoir plus',
		readLess: 'Réduire',
		audience:
			'Il s’adresse aux résidents, aux groupes citoyens, aux journalistes et aux élus qui veulent des faits pour exiger un meilleur service. Le site n’est pas affilié au réseau {operator}.',
		cadence:
			'Le bilan de fiabilité est republié chaque semaine. Quand une donnée manque, nous le disons.',
		cadenceLive: 'Les données en direct sont actualisées environ toutes les {seconds} secondes.',
		headline: 'Le transport à {city},',
		headlineAccent: 'à l’épreuve des données.',
		exploreNav: 'Tout explorer',
	},
	en: {
		auditBody: 'Transit is an independent public record of the bus service {city} actually gets.',
		notPlanner: 'It is not a trip planner.',
		auditMore:
			'It shows how often {operator} buses run late, by how much, and on which lines and stops, using the agency’s own open data.',
		readMore: 'Read more',
		readLess: 'Show less',
		audience:
			'It is for residents, advocates, journalists and councillors who want evidence when they ask for better service. It is not affiliated with {operator}.',
		cadence: 'The reliability record is republished every week. When data is missing, we say so.',
		cadenceLive: 'Live data refreshes about every {seconds} seconds.',
		headline: 'How {city}’s',
		headlineAccent: 'transit holds up.',
		exploreNav: 'Explore everything',
	},
} satisfies Readonly<Record<Locale, Readonly<Record<CopyKey, string>>>>);

export type HomeCopy = (typeof homeCopy)[Locale];

export function homeAuditBody(locale: Locale, city: string): string {
	const body = homeCopy[locale].auditBody;
	const template =
		locale === 'fr' && /^[aeiouyàâäéèêëîïôöùûüœæ]/iu.test(city)
			? body.replace('que {city}', 'qu’{city}')
			: body;
	return template.replace('{city}', city);
}

/** How current the data is. The live rate comes from the network; none is assumed. */
export function homeCadence(locale: Locale, liveSeconds: number | null | undefined): string {
	const t = homeCopy[locale];
	if (liveSeconds == null) return t.cadence;
	return `${t.cadenceLive.replace('{seconds}', String(liveSeconds))} ${t.cadence}`;
}

/** One destination in the home's groups: a menu page, or the house link that leaves Transit. */
export interface HomeEntry {
	readonly href: string;
	readonly title: BilingualLabel;
	readonly desc: BilingualLabel | null;
	readonly external: boolean;
}

export interface HomeGroup {
	readonly key: NavGroupKey;
	readonly label: BilingualLabel;
	readonly entries: readonly HomeEntry[];
}

type Described = Exclude<NavItem['key'], 'overview' | 'vehicles' | 'download'>;

const DESCRIPTIONS: Readonly<Record<Described, BilingualLabel>> = {
	map: {
		en: 'Where are the vehicles now?',
		fr: 'Où sont les véhicules maintenant?',
	},
	network: {
		en: 'Delays, trends and data coverage',
		fr: 'Retards, tendances et couverture des données',
	},
	lines: {
		en: 'One page per line: the schedule, the delays, and how it holds up day after day.',
		fr: 'Une page par ligne : l’horaire, les retards, et sa tenue jour après jour.',
	},
	stops: {
		en: 'Predicted departures and reported reliability at each stop.',
		fr: 'Les passages prévus et la fiabilité observée à chaque arrêt.',
	},
	hotspots: {
		en: 'The lines and stops most often more than 5 minutes late, ranked across the whole network.',
		fr: 'Les lignes et les arrêts le plus souvent en retard de plus de 5 minutes, classés sur l’ensemble du réseau.',
	},
	repeatOffenders: {
		en: 'The trips and vehicles most often more than 5 minutes late, ranked in the open.',
		fr: 'Les trajets et les véhicules le plus souvent en retard de plus de 5 minutes, classés au grand jour.',
	},
	receipt: {
		en: 'Daily delays and observed service counts, compared with the schedule.',
		fr: 'Les retards du jour et les trajets observés, comparés aux volumes prévus.',
	},
	alerts: {
		en: 'Service disruptions in effect right now, plus the record of past ones.',
		fr: 'Les perturbations en vigueur en ce moment, et l’historique des précédentes.',
	},
	metrics: {
		en: 'Every number explained in plain words: what it measures and the limits of the data.',
		fr: 'Chaque chiffre expliqué simplement : ce qu’il mesure et les limites des données.',
	},
	status: {
		en: 'Is our data fresh? When each feed last answered, and the gaps we know about.',
		fr: 'Nos données sont-elles fraîches ? Le dernier signal de chaque flux, et les trous qu’on connaît.',
	},
};

/**
 * The menu's four groups, in the menu's order and words, each page with one line on what it
 * answers. The home itself is left out; Service alerts only when the network has an alert feed.
 */
export function homeGroups(alertsAvailable = true): readonly HomeGroup[] {
	return NAV_GROUPS.map((group) => ({
		key: group.key,
		label: group.label,
		entries: [
			...visibleNav({ alerts: alertsAvailable })
				.filter(
					(item): item is NavItem & { key: Described } =>
						item.group === group.key && item.key in DESCRIPTIONS,
				)
				.map((item) => ({
					href: item.href,
					title: item.label,
					desc: DESCRIPTIONS[item.key],
					external: false,
				})),
			...(group.key === 'about'
				? [
						{
							href: YESID_HOUSE_LINK.href,
							title: YESID_HOUSE_LINK.label,
							desc: null,
							external: true,
						},
					]
				: []),
		],
	}));
}
