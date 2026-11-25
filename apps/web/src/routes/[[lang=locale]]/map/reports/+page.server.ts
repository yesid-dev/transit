import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const target = new URL(url);
	target.pathname = target.pathname.replace(/\/reports\/?$/, '');
	for (const key of ['view', 'mapView', 'tab']) {
		if (target.searchParams.get(key) === 'reports') target.searchParams.delete(key);
	}
	redirect(308, target.pathname + target.search);
};
