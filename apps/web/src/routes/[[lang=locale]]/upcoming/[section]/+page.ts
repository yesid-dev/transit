import { error } from '@sveltejs/kit';
import { upcomingPage } from '#lib/content/nav.ts';
import { delocalizePath } from '#lib/i18n/index.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url }) => {
	const item = upcomingPage(delocalizePath(url.pathname));
	if (!item) error(404);
	return { label: item.label };
};
