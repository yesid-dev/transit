import { error, redirect } from '@sveltejs/kit';
import { upcomingPage } from '#lib/content/nav.ts';
import { delocalizePath, localizeHref, pathLocale } from '#lib/i18n/index.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url }) => {
	if (delocalizePath(url.pathname) === '/upcoming/vehicles') {
		redirect(308, localizeHref('/vehicles', pathLocale(url.pathname)) + url.search);
	}
	const item = upcomingPage(delocalizePath(url.pathname));
	if (!item) error(404);
	return { label: item.label };
};
