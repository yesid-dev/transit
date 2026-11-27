import type { RequestHandler } from './$types';
import { canIndexSite, readPublicSiteConfig } from '#lib/site/config.ts';
import { buildSitemapXml, type SitemapEntities } from '#lib/site/seoFiles.ts';
import { getCityCatalog, getScheduleEdition } from '#lib/server/engine.ts';
import { resolveProvider } from '#lib/v1/providers.ts';

export const prerender = false;

const SITEMAP_CACHE_CONTROL = 'public, max-age=3600, s-maxage=14400';

export const GET: RequestHandler = async (event) => {
	const siteConfig = readPublicSiteConfig();
	const config = { ...siteConfig, indexing: canIndexSite(siteConfig, event.url.origin) };
	let entities: SitemapEntities[] = [];
	if (config.indexing) {
		try {
			const ip = event.request.headers.get('cf-connecting-ip');
			const catalog = await getCityCatalog(ip);
			const selected = resolveProvider(event.url, catalog);
			if (selected.url.href !== event.url.href)
				return new Response(null, {
					status: 307,
					headers: { location: selected.url.pathname + selected.url.search },
				});
			const explicit = event.url.searchParams.has('provider');
			const cities = explicit ? [selected.provider] : catalog.providers;
			entities = await Promise.all(
				cities.map(async ({ id }) => {
					const edition = await getScheduleEdition(id, ip);
					return {
						routeIds: edition?.routes.map((route) => route.id),
						stopIds: edition?.stops.map((stop) => stop.id),
						providerId: explicit || id !== catalog.default_provider ? id : undefined,
					};
				}),
			);
		} catch {
			// Static pages are still crawlable if the city catalog is unavailable.
		}
	}

	return new Response(buildSitemapXml(config, entities), {
		headers: {
			'content-type': 'application/xml; charset=utf-8',
			'cache-control': SITEMAP_CACHE_CONTROL,
		},
	});
};
