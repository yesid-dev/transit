// @vitest-environment node

import { readable } from 'svelte/store';
import { expect, it } from 'vitest';
import { createServer } from 'vite';

it.each(
	[
		{
			locale: 'en' as const,
			path: '/map',
			heading: 'Live map',
			bootStatus: 'Loading the live map',
			activationCopy: 'Load live interactive map',
		},
		{
			locale: 'fr' as const,
			path: '/fr/map',
			heading: 'Carte en direct',
			bootStatus: 'Chargement de la carte en direct',
			activationCopy: 'Charger la carte interactive en direct',
		},
	].flatMap((row) => [
		{ ...row, provider: 'stm', city: 'Montréal', asset: 'montreal' },
		{
			...row,
			provider: 'octranspo',
			city: 'Ottawa',
			asset: 'ottawa',
		},
	]),
)(
	'$path ($provider) server-compiles to the selected boot poster without browser APIs',
	async ({ locale, path, heading, bootStatus, activationCopy, provider, city, asset }) => {
		const server = await createServer({
			configFile: 'vite.config.ts',
			appType: 'custom',
			logLevel: 'silent',
			optimizeDeps: { noDiscovery: true },
			server: { middlewareMode: true },
		});
		try {
			const page = (await server.ssrLoadModule(
				'/src/routes/[[lang=locale]]/map/+page.svelte',
			)) as typeof import('./+page.svelte');
			const { render } = (await server.ssrLoadModule(
				'svelte/server',
			)) as typeof import('svelte/server');
			const context = new Map<unknown, unknown>([
				[
					Symbol.for('transit.v1.context'),
					() => ({
						manifest: { provider, city, files: { live: { ttl_s: 30 } } },
						provider: {
							id: provider,
							labels: { en: { city }, fr: { city } },
							posters_url: `/map/basemap-${asset}-posters.json`,
						},
						labels: {},
						lang: locale,
					}),
				],
				[Symbol.for('@yesid/ui/locale'), () => locale],
				[
					'__svelte__',
					{
						page: readable({ url: new URL(`http://localhost${path}?provider=${provider}`) }),
						navigating: readable(null),
						updated: readable(false),
					},
				],
			]);

			const rendered = render(page.default, { context });
			const body = rendered.body;
			expect(body).toContain('map-progressive');
			expect(body).toContain(`${heading} · ${city}`);
			expect(body).toContain(`/map/basemap-${asset}-`);
			expect(body).not.toContain(`/map/basemap-${asset === 'ottawa' ? 'montreal' : 'ottawa'}-`);
			expect(body).not.toContain(bootStatus);
			expect(body).not.toContain(activationCopy);
			expect(body).not.toContain('data-map-wake');
			expect(body).not.toContain('map-intent');
			expect(body).not.toContain('<button');
			expect(body).toMatch(/<p[^>]*role="status"[^>]*aria-live="polite"/u);
			expect(body).toContain('<noscript');
			expect(body).toContain('https://www.openstreetmap.org/copyright');
			expect(body).toContain('https://github.com/protomaps/basemaps');
			expect(body).not.toContain('map-hero');
			expect(body).not.toContain('NETWORK · LIVE');
			expect(body).not.toContain('RÉSEAU · EN DIRECT');
			expect(rendered.head).not.toContain('protomaps.github.io');
		} finally {
			await server.close();
		}
	},
	20_000,
);
