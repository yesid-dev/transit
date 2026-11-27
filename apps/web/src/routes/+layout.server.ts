import type { LayoutServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { DEFAULT_LOCALE, type Locale } from '#lib/i18n/index.ts';
import { bootProvider } from '#lib/v1/boot.ts';
import { captureContext } from '#lib/live/captureContext.ts';
import { getCityCatalog, getRecordDataHealth, getScheduleEdition } from '#lib/server/engine.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import { lineFrameView } from '#lib/site/lineFrame.ts';
import { stopFrameView } from '#lib/site/stopFrame.ts';
import { networkRecordView } from '#lib/site/networkFrame.ts';
import { departureFromKey } from '#lib/features/record/departureIdentity.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import { linePatterns } from '#lib/site/linePatterns.ts';

const localRoute = '/[[lang=locale]]';

function usesLiveSnapshots(route: string | null, url: URL): boolean {
	switch (route) {
		case localRoute + '/map':
			return true;

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
		case localRoute + '/network':
			return {
				date,
				routes,
				stops: [],
				...(!networkRecordView(url) && route_directions
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
			return { date, routes: [], stops: [] };
		case localRoute + '/stop/[id]': {
			const id = params.id?.trim() || params.id;
			const stop = stops.find((entry) => entry.id === id);
			const related = stopFrameView(url) === 'live' ? (stop?.routes ?? []) : [];
			return {
				date,
				routes,
				stops: stop ? [stop] : [],
				...(related.length && route_directions
					? {
							route_directions: Object.fromEntries(
								related.map((line) => [
									line,
									(route_directions[line] ?? [])
										.filter((direction) => direction.stops?.some((entry) => entry.id === id))
										.map(({ dir, headsign }) => ({ dir, headsign })),
								]),
							),
						}
					: {}),
			};
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

/**
 * The lines whose termini a page needs, so every screen that names a direction can write it as
 * the terminus ("Toward Station Laurier (Est)"). Computed from the whole timetable, before the
 * page's trimmed copy drops each direction's stops.
 */
function patternLines(
	route: string | null,
	params: Partial<Record<string, string>>,
	url: URL,
	schedule: ScheduleEdition,
): 'all' | ReadonlySet<string> | null {
	switch (route) {
		case localRoute + '/lines':
		case localRoute + '/vehicles':
		case localRoute + '/vehicle/[id]':
		case localRoute + '/rankings':
		case localRoute + '/map':
			return 'all';
		case localRoute + '/network':
			return networkRecordView(url) ? null : 'all';
		case localRoute + '/lines/[id]': {
			const id = params.id?.trim() || params.id;
			return id ? new Set([id]) : null;
		}
		case localRoute + '/departure/[key]': {
			const line = departureFromKey(params.key ?? '')?.line;
			return line ? new Set([line]) : null;
		}
		case localRoute + '/stop/[id]': {
			const id = params.id?.trim() || params.id;
			const lines = schedule.stops.find((stop) => stop.id === id)?.routes ?? [];
			return lines.length ? new Set(lines) : null;
		}
		default:
			return null;
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
		() => getCityCatalog(visitorIp),
		locals.approximateLocation,
	);
	if (selection.redirectHref) redirect(307, selection.redirectHref);
	if (selection.discoveryError) event.setHeaders({ 'cache-control': 'no-store' });
	const schedule =
		needsSchedule && selection.provider
			? await getScheduleEdition(selection.providerId, visitorIp)
			: null;
	// Overview combines schedule totals with a small set of ranked stop names.
	// Keep the untrimmed schedule on the server for its page loader.
	if (route === localRoute && !loadSnapshots) locals.overviewSchedule = schedule;
	if (route === localRoute + '/rankings') locals.rankingsSchedule = schedule;
	if (route === localRoute + '/stops') locals.stopsSchedule = schedule;
	const v1 =
		loadSnapshots && selection.provider ? captureContext(selection.provider, lang, schedule) : null;
	const provider = selection.provider;
	const lines = schedule ? patternLines(route, params, event.url, schedule) : null;
	const patterns = schedule && lines ? linePatterns(schedule, lines) : undefined;
	const period =
		!loadSnapshots && needsSchedule && provider?.download_licence?.source_date_required
			? parseAnswerFrameState(event.url.searchParams, frameClock(provider)).period
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
		...(patterns ? { patterns } : {}),
		lang,
		...selection,
		v1,
		...(recordSourceDate ? { recordSourceDate } : {}),
		loadSnapshots,
		serverBoot: v1 ? ('succeeded' as const) : ('failed' as const),
	};
};
