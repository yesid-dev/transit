import type { PublicSiteConfig } from './config';
import { localizeHref } from '#lib/i18n/index.ts';
import { rankingKinds, rankingPathForKind } from '#lib/features/rankings/rankingUrls.ts';
import {
	emitAlternateSitemapEntries,
	emitSitemapDocument,
	robotsTxt,
} from '@yesid/seo-kit/sitemap';

export { toW3CDate } from '@yesid/seo-kit/sitemap';

export const PATHS = [
	'/',
	'/map',
	'/lines',
	'/stops',
	'/vehicles',
	'/network',
	'/search',
	'/metrics',
	'/status',
	...rankingKinds.map(rankingPathForKind),
	'/receipt',
	'/alerts',
	'/privacy',
	'/terms',
	'/accessibility',
	'/roadmap',
] as const;

export const SITEMAP_URL_CAP = 50_000;

const ROUTE_PREFIX = '/lines/';
const STOP_PREFIX = '/stop/';

function entityPath(prefix: string, id: string): string {
	return `${prefix}${encodeURIComponent(id)}`;
}

export interface SitemapEntities {
	readonly routeIds?: readonly string[];
	readonly stopIds?: readonly string[];
	readonly entityLastmod?: string | null;
	readonly staticLastmod?: string | null;
	readonly providerId?: string;
}

export function buildRobotsTxt(config: PublicSiteConfig): string {
	return robotsTxt({
		// Crawlers must be able to read the noindex response header.
		indexing: true,
		sitemap: config.indexing ? `${config.siteOrigin}/sitemap.xml` : undefined,
		disallow: ['/_kit', '/fr/_kit', '/api/'],
	});
}

function localizedEntries(
	siteOrigin: string,
	path: string,
	lastmod: string | null,
	providerId?: string,
): string[] {
	const en = `${siteOrigin}${localizeHref(path, 'en', providerId)}`;
	const fr = `${siteOrigin}${localizeHref(path, 'fr', providerId)}`;
	return emitAlternateSitemapEntries({
		variants: [
			{ hreflang: 'en', href: en },
			{ hreflang: 'fr', href: fr },
		],
		xDefaultHref: en,
		lastmod,
		emptyElementStyle: 'compact',
	});
}

export function _sitemapEntries(
	siteOrigin: string,
	staticLastmod: string | null = null,
	providerId?: string,
): string[] {
	return PATHS.flatMap((path) => localizedEntries(siteOrigin, path, staticLastmod, providerId));
}

export function _entitySitemapEntries(
	siteOrigin: string,
	prefix: string,
	ids: readonly string[],
	entityLastmod: string | null = null,
	providerId?: string,
): string[] {
	return ids.flatMap((id) =>
		localizedEntries(siteOrigin, entityPath(prefix, id), entityLastmod, providerId),
	);
}

export function buildSitemapXml(
	config: PublicSiteConfig,
	cities: SitemapEntities | readonly SitemapEntities[] = [],
): string {
	const urls = config.indexing
		? collectUrlBlocks(config.siteOrigin, 'length' in cities ? cities : [cities])
		: [];

	return emitSitemapDocument(urls, { trailingNewline: true });
}

function collectUrlBlocks(siteOrigin: string, cities: readonly SitemapEntities[]): string[] {
	const staticBlocks = (cities.length ? cities : [{}]).flatMap((city) =>
		_sitemapEntries(siteOrigin, city.staticLastmod, city.providerId),
	);
	const routeBlocks = cities.flatMap((city) =>
		_entitySitemapEntries(
			siteOrigin,
			ROUTE_PREFIX,
			city.routeIds ?? [],
			city.entityLastmod,
			city.providerId,
		),
	);
	const stopBlocks = cities.flatMap((city) =>
		_entitySitemapEntries(
			siteOrigin,
			STOP_PREFIX,
			city.stopIds ?? [],
			city.entityLastmod,
			city.providerId,
		),
	);

	const all = [...staticBlocks, ...routeBlocks, ...stopBlocks];
	if (all.length <= SITEMAP_URL_CAP) return all;

	const head = [...staticBlocks, ...routeBlocks];
	if (head.length >= SITEMAP_URL_CAP) return head.slice(0, SITEMAP_URL_CAP);
	const remaining = SITEMAP_URL_CAP - head.length;
	const evenRemaining = remaining - (remaining % 2);
	return [...head, ...stopBlocks.slice(0, evenRemaining)];
}
