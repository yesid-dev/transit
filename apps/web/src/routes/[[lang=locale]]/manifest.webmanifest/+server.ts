import type { RequestHandler } from './$types';
import { DEPLOYMENT_IDENTITY } from '#lib/site/deployment.ts';

export const prerender = true;
export const entries = () => [{}, { lang: 'fr' }];

export const GET: RequestHandler = ({ params }) => {
	const fr = params.lang === 'fr';
	const manifest = {
		name: DEPLOYMENT_IDENTITY.name,
		short_name: DEPLOYMENT_IDENTITY.shortName,
		description: fr
			? 'Un bilan public et indépendant du service de transport effectué. Pas un planificateur de trajets.'
			: 'An independent public record of the transit service delivered. Not a trip planner.',
		start_url: '/',
		scope: '/',
		display: 'standalone',
		orientation: 'any',
		background_color: '#141414',
		theme_color: '#141414',
		lang: fr ? 'fr' : 'en',
		dir: 'ltr',
		categories: ['travel', 'utilities'],
		icons: [
			{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
			{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
			{
				src: '/apple-touch-icon-180.png',
				sizes: '180x180',
				type: 'image/png',
				purpose: 'any',
			},
		],
	};
	return new Response(JSON.stringify(manifest, null, '\t'), {
		headers: { 'content-type': 'application/manifest+json' },
	});
};
