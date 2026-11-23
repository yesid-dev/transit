import type { LayoutServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { DEFAULT_LOCALE, type Locale } from '#lib/i18n/index.ts';
import { bootProvider } from '#lib/v1/boot.ts';
import { serverV1Context } from '#lib/v1/serverContext.ts';
import { getCityCatalog, getScheduleEdition } from '#lib/server/engine.ts';
import { lineFrameView } from '#lib/site/lineFrame.ts';
import { stopFrameView } from '#lib/site/stopFrame.ts';
import { networkRecordView } from '#lib/site/networkFrame.ts';

const localRoute = '/[[lang=locale]]';

function usesLiveSnapshots(route: string | null, url: URL): boolean {
	switch (route) {
		case localRoute + '/map':
		case localRoute + '/trip/[id]':
			return true;
		case localRoute + '/lines/[id]':
			return lineFrameView(url) === 'live';
		case localRoute + '/stop/[id]':
			return stopFrameView(url) === 'live';
		case localRoute + '/network':
			return !networkRecordView(url);
		case localRoute:
		case localRoute + '/alerts':
		case localRoute + '/status':
		case localRoute + '/vehicles':
		case localRoute + '/vehicle/[id]':
		case localRoute + '/departure/[key]':
			return url.searchParams.get('frameMode') === 'live';
		default:
			return false;
	}
}

export const load: LayoutServerLoad = async (event) => {
	const { params, locals } = event;
	const lang = (params.lang as Locale | undefined) ?? locals.locale ?? DEFAULT_LOCALE;

	const route = event.route.id;
	const needsSchedule = route !== localRoute + '/search' && route !== localRoute + '/download';
	const loadSnapshots = usesLiveSnapshots(route, event.url);
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	const selection = await bootProvider(
		event.url,
		lang,
		() => getCityCatalog(visitorIp),
		loadSnapshots ? serverV1Context(event) : undefined,
		locals.approximateLocation,
		loadSnapshots,
	);
	if (selection.redirectHref) redirect(307, selection.redirectHref);
	if (selection.discoveryError) event.setHeaders({ 'cache-control': 'no-store' });
	const schedule =
		needsSchedule && selection.provider
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
		loadSnapshots,
		serverBoot: selection.v1 ? ('succeeded' as const) : ('failed' as const),
	};
};
