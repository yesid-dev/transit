import { error, redirect } from '@sveltejs/kit';
import { delocalizePath, localizeHref, pathLocale } from '#lib/i18n/index.ts';
import type { PageLoad } from './$types';

// Two old menu addresses now have pages of their own; every other section is gone.
export const load: PageLoad = ({ url }) => {
	const path = delocalizePath(url.pathname);
	if (path === '/upcoming/vehicles' || path === '/upcoming/download') {
		redirect(
			308,
			localizeHref(path.replace('/upcoming', ''), pathLocale(url.pathname)) + url.search,
		);
	}
	error(404);
};
