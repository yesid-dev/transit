import type { LayoutServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { DEFAULT_LOCALE, type Locale } from '#lib/i18n/index.ts';
import { bootProvider } from '#lib/v1/boot.ts';
import { captureContext } from '#lib/live/captureContext.ts';
import { getCityCatalog, getRecordDataHealth, getScheduleEdition } from '#lib/server/engine.ts';
import { calendarClock, frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import { lineFrameView } from '#lib/site/lineFrame.ts';
import { stopFrameView } from '#lib/site/stopFrame.ts';
import { networkRecordView } from '#lib/site/networkFrame.ts';
import { departureFromKey } from '#lib/features/record/departureIdentity.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';

const localRoute = '/[[lang=locale]]';

function usesLiveSnapshots(route: string | null, url: URL): boolean {
	switch (route) {
		case localRoute + '/map':
			return true;

		case localRoute + '/stop/[id]':
			return stopFrameView(url) === 'live';
		case localRoute:
		case localRoute + '/vehicles':
		case localRoute + '/vehicle/[id]':
		case localRoute + '/departure/[key]':
			return url.searchParams.get('frameMode') === 'live';
		default:
			return false;
	}
}

function scheduleForPage(
	schedule: ScheduleEdition,
	{ route, params, url }: Parameters<LayoutServerLoad>[0],
): ScheduleEdition {
	const { date, routes, stops, route_directions } = schedule;
	switch (route.id) {
		case localRoute + '/lines':
		case localRoute + '/network':
			return {
				date,
				routes,
				stops: [],
				...((route.id === localRoute + '/lines' || !networkRecordView(url)) && route_directions
					? {
							route_directions: Object.fromEntries(
								Object.entries(route_directions).map(([id, directions]) => [
									id,
									directions.map(({ dir, headsign }) => ({ dir, headsign })),
								]),
							),
						}
					: {}),
			};
		case localRoute + '/stops':
			return schedule;
		case localRoute + '/stop/[id]': {
			const id = params.id?.trim() || params.id;
			return { date, routes, stops: stops.filter((stop) => stop.id === id) };
		}
		case localRoute + '/lines/[id]':
		case localRoute + '/departure/[key]': {
			const id =
				route.id === localRoute + '/lines/[id]'
					? params.id?.trim() || params.id
					: departureFromKey(params.key ?? '')?.line;
			const directions = id ? route_directions?.[id] : undefined;
			return {
				date,
				routes,
				stops: id ? stops.filter((stop) => stop.routes?.includes(id)) : [],
				...(id && directions
					? {
							route_directions: {
								[id]: directions.map(({ dir, headsign, stops }) => ({
									dir,
									headsign,
									...(route.id === localRoute + '/lines/[id]' && lineFrameView(url) === 'live'
										? { stops }
										: {}),
								})),
							},
						}
					: {}),
			};
		}
		default:
			return { date, routes, stops: [] };
	}
}

export const load: LayoutServerLoad = async (event) => {
	const { params, locals } = event;
	const lang = (params.lang as Locale | undefined) ?? locals.locale ?? DEFAULT_LOCALE;

	const route = event.route.id;
	const needsSchedule = !['/search', '/download', '/trip/[id]'].some(
		(path) => route === localRoute + path,
	);
	const loadSnapshots = usesLiveSnapshots(route, event.url);
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	const selection = await bootProvider(
		event.url,
		lang,
		() => getCityCatalog(visitorIp),
		undefined,
		locals.approximateLocation,
		false,
	);
	if (selection.redirectHref) redirect(307, selection.redirectHref);
	if (selection.discoveryError) event.setHeaders({ 'cache-control': 'no-store' });
	const fixtureScope = event.request.headers.get('x-transit-fixture-scope');
	const schedule =
		needsSchedule && selection.provider
			? fixtureScope
				? await getScheduleEdition(selection.providerId, visitorIp, fixtureScope)
				: await getScheduleEdition(selection.providerId, visitorIp)
			: null;
	// Overview combines schedule totals with a small set of ranked stop names.
	// Keep the untrimmed schedule on the server for its page loader.
	if (route === localRoute && !loadSnapshots) locals.overviewSchedule = schedule;
	const v1 =
		loadSnapshots && selection.provider ? captureContext(selection.provider, lang, schedule) : null;
	const provider = selection.provider;
	const period =
		!loadSnapshots && needsSchedule && provider?.download_licence?.source_date_required
			? parseAnswerFrameState(
					event.url.searchParams,
					route === localRoute + '/status' ? calendarClock(provider) : frameClock(provider),
				).period
			: null;
	const recordSourceDate = period
		? getRecordDataHealth({ ...period, city: selection.providerId, visitorIp }).then((result) =>
				result.kind === 'answer'
					? (result.answer.days
							.flatMap((day) => day.source_date ?? [])
							.sort()
							.at(-1) ?? null)
					: null,
			)
		: null;
	return {
		schedule: schedule ? scheduleForPage(schedule, event) : null,
		lang,
		...selection,
		v1,
		...(recordSourceDate ? { recordSourceDate } : {}),
		loadSnapshots,
		serverBoot: v1 ? ('succeeded' as const) : ('failed' as const),
	};
};
