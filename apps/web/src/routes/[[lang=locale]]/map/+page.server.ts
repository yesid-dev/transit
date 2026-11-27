import { redirect } from '@sveltejs/kit';
import { mapLayerFor } from '#lib/site/mapFrame.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const target = new URL(url);
	for (const key of ['view', 'mapView', 'tab']) {
		if (target.searchParams.get(key) === 'reports') target.searchParams.delete(key);
	}
	if (url.search !== target.search) redirect(308, target.pathname + target.search);
	return { record: mapLayerFor(url.searchParams) !== 'live' };
};
