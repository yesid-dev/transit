import type { RequestHandler } from './$types';
import { canIndexSite, readPublicSiteConfig } from '#lib/site/config.ts';
import { buildRobotsTxt } from '#lib/site/seoFiles.ts';

// Use the same Worker indexing setting as the sitemap and document headers.
export const prerender = false;

export const GET: RequestHandler = ({ url }) => {
	const config = readPublicSiteConfig();
	return new Response(buildRobotsTxt({ ...config, indexing: canIndexSite(config, url.origin) }), {
		headers: { 'content-type': 'text/plain; charset=utf-8' },
	});
};
