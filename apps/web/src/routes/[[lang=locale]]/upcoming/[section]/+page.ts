import { error, redirect } from '@sveltejs/kit';
import { upcomingPage } from '#lib/content/nav.ts';
import { delocalizePath, localizeHref, pathLocale } from '#lib/i18n/index.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url }) => {
	const path = delocalizePath(url.pathname);
	if (path === '/upcoming/vehicles' || path === '/upcoming/download') {
		redirect(
			308,
			localizeHref(path.replace('/upcoming', ''), pathLocale(url.pathname)) + url.search,
		);
	}
	const item = upcomingPage(path);
	if (!item) error(404);
	return { label: item.label };
};
