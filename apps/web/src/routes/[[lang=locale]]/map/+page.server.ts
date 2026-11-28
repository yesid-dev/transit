import { redirect } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { mapLayerFor } from '#lib/site/mapFrame.ts';
import type { PageServerLoad } from './$types';

let startupModules: Promise<string[]> | undefined;

function mapStartupModules(url: URL): Promise<string[]> {
	const assets = env.ASSETS;
	if (!assets) return Promise.resolve([]);
	return (startupModules ??= assets
		.fetch(new Request(new URL('/map/startup-modules.json', url)))
		.then(async (response) => {
			if (!response.ok) return [];
			const files: unknown = await response.json();
			return Array.isArray(files)
				? files.filter(
						(file): file is string =>
							typeof file === 'string' && /^_app\/immutable\/chunks\/[\w.-]+\.js$/u.test(file),
					)
				: [];
		})
		.catch(() => []));
}

export const load: PageServerLoad = async ({ url }) => {
	const target = new URL(url);
	for (const key of ['view', 'mapView', 'tab']) {
		if (target.searchParams.get(key) === 'reports') target.searchParams.delete(key);
	}
	if (url.search !== target.search) redirect(308, target.pathname + target.search);
	return {
		record: mapLayerFor(url.searchParams) !== 'live',
		startupModules: await mapStartupModules(url),
	};
};
