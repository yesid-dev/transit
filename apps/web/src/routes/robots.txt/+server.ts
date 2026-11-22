import type { RequestHandler } from './$types';
import { readPublicSiteConfig } from '#lib/site/config.ts';
import { buildRobotsTxt } from '#lib/site/seoFiles.ts';

// Use the same Worker indexing setting as the sitemap and document headers.
export const prerender = false;

export const GET: RequestHandler = () =>
	new Response(buildRobotsTxt(readPublicSiteConfig()), {
		headers: { 'content-type': 'text/plain; charset=utf-8' },
	});
