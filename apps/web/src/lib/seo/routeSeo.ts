import { shareCopy, shareKey } from './share-copy';
import { delocalizePath, localizeHref } from '../i18n/routing';
import type { Locale } from '../i18n/config';
import { roadmapTitle } from '../features/roadmap/roadmap.copy';
import cards from '../../../static/og/manifest.json';
import { upcomingPage } from '#lib/content/nav.ts';
import { mapLayerFor } from '#lib/site/mapFrame.ts';
import {
	rankingPath,
	rankingPathForKind,
	rankingSelection,
} from '#lib/features/rankings/rankingUrls.ts';

export interface RouteSeo {
	title: string;
	description: string;
	siteName: string;
	providerId?: string;
	imagePath: string;
	imageAlt: string;
}

export interface BreadcrumbTrailItem {
	name: string;
	path: string;
}

const CRUMB_LABELS = {
	home: { en: 'Home', fr: 'Accueil' },
	lines: { en: 'Lines', fr: 'Lignes' },
	stops: { en: 'Stops', fr: 'Arrêts' },
} satisfies Record<string, BilingualText>;

const DATASET_COPY = {
	name: { en: 'Open transit dataset', fr: 'Jeu de données de transport ouvert' },
	description: {
		en: 'Open transit reliability, schedule and vehicle-report data, published under CC BY 4.0.',
		fr: 'Données ouvertes sur la fiabilité, les horaires et les véhicules du réseau, publiées sous CC BY 4.0.',
	},
} satisfies Record<'name' | 'description', BilingualText>;

export interface ProviderSeoIdentity {
	id?: string | null;
	shortName?: string | null;
	city?: string | null;
}

interface ResolvedIdentity {
	shortName: string;
	city: string;
}

interface BilingualText {
	readonly en: string;
	readonly fr: string;
}

interface BilingualSeo {
	readonly title: BilingualText;
	readonly description?: BilingualText;
}

const HOME: BilingualSeo & {
	readonly keywordTitle: (id: ResolvedIdentity) => BilingualText;
} = {
	title: { en: 'Transit network overview', fr: 'Vue d’ensemble du réseau' },
	description: {
		en: 'An independent public record of transit service delivered.',
		fr: 'Un bilan public et indépendant du service de transport effectué.',
	},
	keywordTitle: (id) => ({
		en: `${id.shortName} network overview`,
		fr: `Vue du réseau ${id.shortName}`,
	}),
};

const SURFACES: Record<string, BilingualSeo> = {
	'/map': {
		title: { en: 'Live map', fr: 'Carte en direct' },
		description: {
			en: 'Where vehicles last reported, with transit stops and lines.',
			fr: 'Les dernières positions signalées des véhicules, les arrêts et les lignes.',
		},
	},
	'/lines': {
		title: { en: 'Lines', fr: 'Lignes' },
	},
	'/stops': {
		title: { en: 'Stops', fr: 'Arrêts' },
	},
	'/vehicles': {
		title: { en: 'Vehicles', fr: 'Véhicules' },
		description: {
			en: 'Every vehicle seen in service, with its days, hours and lines.',
			fr: 'Chaque véhicule vu en service, avec ses jours, ses heures et ses lignes.',
		},
	},
	'/network': {
		title: { en: 'Network health', fr: 'Santé du réseau' },
	},
	'/search': {
		title: { en: 'Search', fr: 'Recherche' },
	},
	'/metrics': {
		title: { en: 'How we measure', fr: 'Comment on mesure' },
	},
	'/metrics/archive': {
		description: {
			en: 'Read the definitions and sources used by the first Transit site through November 2026.',
			fr: 'Consultez les définitions et les sources du premier site Transit, jusqu’en novembre 2026.',
		},
		title: {
			en: 'Previous method, through November 2026',
			fr: 'Ancienne méthode, jusqu’en novembre 2026',
		},
	},
	'/status': {
		description: {
			en: 'When the agency last sent data, what it sends and where the record has gaps.',
			fr: 'Quand la société de transport a transmis ses données, ce qu’elle publie et les lacunes du bilan.',
		},
		title: { en: 'Data health', fr: 'Santé des données' },
	},
	'/download': {
		description: {
			en: 'The cleaned daily files behind every figure, under the agency’s licence.',
			fr: 'Les fichiers quotidiens nettoyés derrière chaque chiffre, sous la licence de la société de transport.',
		},
		title: { en: 'Download the data', fr: 'Télécharger les données' },
	},
	'/rankings': {
		title: { en: 'Worst lines', fr: 'Pires lignes' },
	},
	'/receipt': {
		title: { en: 'Daily report', fr: 'Rapport quotidien' },
	},
	'/alerts': {
		title: { en: 'Service alerts', fr: 'Avis de service' },
		description: {
			en: 'Notices from the transit agency and the service they affect.',
			fr: 'Avis de la société de transport et services touchés.',
		},
	},
	'/privacy': {
		title: { en: 'Privacy', fr: 'Confidentialité' },
	},
	'/terms': {
		title: { en: 'Terms', fr: 'Conditions d’utilisation' },
	},
	'/accessibility': {
		title: { en: 'Accessibility', fr: 'Accessibilité' },
	},
	'/roadmap': {
		title: roadmapTitle,
	},
};

const LINE_DETAIL: BilingualSeo = {
	title: { en: 'Line record', fr: 'Bilan de la ligne' },
};

// The map's Record view shows the record of stops and corridors, not live vehicles (WCAG 2.4.2).
export const MAP_RECORD: BilingualSeo = {
	title: { en: 'Record map', fr: 'Carte du bilan' },
};

const STOP_DETAIL: BilingualSeo = {
	title: { en: 'Stop record', fr: 'Bilan de l’arrêt' },
};

const VEHICLE_DETAIL: BilingualSeo = {
	title: { en: 'Vehicle record', fr: 'Bilan du véhicule' },
	description: {
		en: 'Where this vehicle ran, its hours in service and how on time it was.',
		fr: 'Où ce véhicule a roulé, ses heures en service et sa ponctualité.',
	},
};

const DEPARTURE_DETAIL: BilingualSeo = {
	title: { en: 'Departure record', fr: 'Bilan du départ' },
	description: {
		en: 'How late this departure ran, stop by stop, over the chosen dates.',
		fr: 'Le retard de ce départ, arrêt par arrêt, aux dates choisies.',
	},
};

function entryFor(path: string, params: URLSearchParams): BilingualSeo {
	if (path === '/') return HOME;
	if (path === '/map' && mapLayerFor(params) !== 'live') return MAP_RECORD;
	if (SURFACES[path]) return SURFACES[path];
	if (path.startsWith('/lines/')) return LINE_DETAIL;
	if (path.startsWith('/stop/')) return STOP_DETAIL;
	if (path.startsWith('/vehicle/')) return VEHICLE_DETAIL;
	if (path.startsWith('/departure/')) return DEPARTURE_DETAIL;
	const upcoming = upcomingPage(path);
	if (upcoming) return { title: upcoming.label };
	return HOME;
}

export function isEphemeralPath(pathname: string): boolean {
	const path = delocalizePath(pathname);
	return path === '/metrics/archive' || path.startsWith('/trip/') || Boolean(upcomingPage(path));
}

export function canonicalRoutePath(url: URL): string {
	const path = delocalizePath(url.pathname);
	return path === rankingPath
		? rankingPathForKind(rankingSelection(rankingPath, url.searchParams).kind)
		: path;
}

function resolveIdentity(identity?: ProviderSeoIdentity): ResolvedIdentity | null {
	const shortName = identity?.shortName?.trim();
	const city = identity?.city?.trim();
	if (!shortName || !city) return null;
	return { shortName, city };
}

export function resolveRouteSeo(
	url: string | URL,
	locale: Locale,
	identity?: ProviderSeoIdentity,
): RouteSeo {
	const request = typeof url === 'string' ? new URL(url, 'https://transit.local') : url;
	const path = delocalizePath(request.pathname);
	const entry = entryFor(path, request.searchParams);
	const requested = request.searchParams.getAll('provider');
	// The caller supplies identity only from successful provider discovery.
	const providerId =
		requested.length === 1 && requested[0] === identity?.id
			? (identity?.id ?? undefined)
			: undefined;
	const resolved = resolveIdentity(identity);
	const homeProvider =
		path === '/' && providerId && resolved
			? cards.providers.find(
					(provider) =>
						provider.id === providerId &&
						provider.labels[locale].operator === resolved.shortName &&
						provider.labels[locale].city === resolved.city,
				)
			: undefined;
	const copy = shareCopy(path, locale);
	const description = entry.description?.[locale] ?? `${copy.support}.`;
	const key = shareKey(path);
	const defaultImage =
		key === '/'
			? `/og/${locale}.png`
			: `/og/pages/${key.slice(1).replaceAll('/', '-')}.${locale}.png`;
	const variant = homeProvider ? `/og/home/${homeProvider.id}.${locale}.png` : defaultImage;
	const image = Object.hasOwn(cards.outputs, variant) ? variant : defaultImage;
	const fingerprint = cards.outputs[image as keyof typeof cards.outputs];
	const imagePath = `${image}?v=${fingerprint.slice(0, 16)}`;
	const imageAlt = homeProvider
		? `${homeProvider.labels[locale].operator} · ${homeProvider.labels[locale].city} · Transit`
		: entry.title[locale];
	if (path === '/' && providerId && resolved) {
		const title = HOME.keywordTitle(resolved);
		return {
			title: title[locale],
			description: `${resolved.shortName} · ${resolved.city}. ${description}`,
			siteName: 'Transit',
			providerId,
			imagePath,
			imageAlt,
		};
	}
	return {
		title: entry.title[locale],
		description,
		siteName: 'Transit',
		providerId,
		imagePath,
		imageAlt,
	};
}

export function resolveBreadcrumbTrail(
	pathname: string,
	locale: Locale,
	name?: string | null,
): BreadcrumbTrailItem[] {
	const path = delocalizePath(pathname);
	const home: BreadcrumbTrailItem = { name: CRUMB_LABELS.home[locale], path: '/' };

	if (path.startsWith('/lines/')) {
		const id = decodeURIComponent(path.slice('/lines/'.length));
		if (!id) return [];
		return [
			home,
			{ name: CRUMB_LABELS.lines[locale], path: '/lines' },
			{ name: name?.trim() ? name : id, path },
		];
	}
	if (path.startsWith('/stop/')) {
		const id = decodeURIComponent(path.slice('/stop/'.length));
		if (!id) return [];
		return [
			home,
			{ name: CRUMB_LABELS.stops[locale], path: '/stops' },
			{ name: name?.trim() ? name : id, path },
		];
	}
	return [];
}

export function resolveDatasetSeo(locale: Locale): { name: string; description: string } {
	return { name: DATASET_COPY.name[locale], description: DATASET_COPY.description[locale] };
}

export function breadcrumbItemsForHead(
	pathname: string,
	locale: Locale,
	siteOrigin: string,
	provider?: string,
	name?: string | null,
): { name: string; url: string }[] {
	return resolveBreadcrumbTrail(pathname, locale, name).map((crumb) => ({
		name: crumb.name,
		url: `${siteOrigin}${localizeHref(crumb.path, locale, provider)}`,
	}));
}

export function resolveCardTitle(path: string, locale: Locale): string {
	return entryFor(path, new URLSearchParams()).title[locale];
}
