import type { LayoutServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { DEFAULT_LOCALE, type Locale } from '#lib/i18n/index.ts';
import { bootProvider } from '#lib/v1/boot.ts';
import { serverV1Context } from '#lib/v1/serverContext.ts';
import { getCityCatalog, getScheduleEdition } from '#lib/server/engine.ts';

export const load: LayoutServerLoad = async (event) => {
	const { params, locals } = event;
	const lang = (params.lang as Locale | undefined) ?? locals.locale ?? DEFAULT_LOCALE;

	const route = event.route.id;
	const searchPage = route === '/[[lang=locale]]/search';
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	const selection = await bootProvider(
		event.url,
		lang,
		() => getCityCatalog(visitorIp),
		serverV1Context(event),
		locals.approximateLocation,
		!searchPage,
	);
	if (selection.redirectHref) redirect(307, selection.redirectHref);
	if (selection.discoveryError) event.setHeaders({ 'cache-control': 'no-store' });
	const schedule =
		!searchPage && selection.provider
			? await getScheduleEdition(selection.providerId, visitorIp)
			: null;
	const usesStopIdentities =
		route != null && /\/(?:stops|(?:stop|lines|departure)\/\[\w+\])$/.test(route);
	return {
		schedule:
			schedule && !usesStopIdentities
				? { date: schedule.date, routes: schedule.routes, stops: [] }
				: schedule,
		lang,
		...selection,
		serverBoot: selection.v1 ? ('succeeded' as const) : ('failed' as const),
	};
};
