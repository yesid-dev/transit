import { loadLineRecord, lineDirection } from '#lib/server/lineRecord.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import { lineFrameView } from '#lib/site/lineFrame.ts';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import { routeNameFallback } from '#lib/site/nameFallback.ts';
import { linePageTitle } from '#lib/seo/riderPageTitle.ts';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { canonicalDetailTabLocation, detailTabFromSearchParams } from '#lib/site/detailTabs.ts';
import { historyRangeRequestFromSearchParams } from '#lib/v1/history/rangeResource.svelte.ts';
import { loadLineHistorySeed } from '#lib/features/lines/reliability/data/lineHistoryResource.svelte.ts';
import { getRouteReliability } from '#lib/v1/repositories/historic.ts';
import { getRoute } from '#lib/v1/repositories/static.ts';
import { serverV1Context, type IdentitySeed } from '#lib/v1/serverContext.ts';

export const load: PageServerLoad = async (event) => {
	const canonicalLocation = canonicalDetailTabLocation(event.url);
	if (canonicalLocation) redirect(308, canonicalLocation);

	const id = event.params.id.trim() || event.params.id;
	const fallback: IdentitySeed = { id, name: id };
	const { url } = event;
	const tab = detailTabFromSearchParams(url.searchParams);
	const { mode, period } = parseFrameState(url.searchParams, frameToday());
	const view = lineFrameView(url);
	const frameLive = view === 'live';
	if (frameLive && (tab !== 'detail' || mode !== 'live')) {
		const live = new URL(url);
		live.searchParams.set('tab', 'detail');
		live.searchParams.set('frameMode', 'live');
		redirect(307, live.pathname + live.search);
	}

	const { v1, routesIndex, lang, providerId } = await event.parent();
	const record =
		view && view !== 'live' && period
			? loadLineRecord(
					view,
					period,
					providerId,
					id,
					lineDirection(url.searchParams),
					event.request.headers.get('cf-connecting-ip'),
				)
			: null;
	if (record) {
		const directory = createLineDirectory(routesIndex?.routes ?? null, {
			line: (routeId) => routeNameFallback(routeId, lang),
		});
		const name = directory.name(id);
		const metadata = v1
			? getRoute(id, {
					...serverV1Context(event),
					providerId,
					manifest: v1.manifest,
				}).catch(() => null)
			: Promise.resolve(null);
		return {
			seed: { id, name: name.label },
			metadata,
			seoTitle: linePageTitle(name),
			record,
			frameLive,
			routeSeed: null,
			reliabilitySeed: null,
			lineHistorySeed: null,
		};
	}
	if (!v1)
		return {
			seed: fallback,
			...(frameLive ? { frameLive } : {}),
			routeSeed: null,
			reliabilitySeed: null,
			lineHistorySeed: null,
		};
	const context = {
		...serverV1Context(event),
		providerId: v1.manifest.provider,
		manifest: v1.manifest,
	};
	const request = historyRangeRequestFromSearchParams(event.url.searchParams);
	const selectedHistory =
		detailTabFromSearchParams(event.url.searchParams) === 'reliability' &&
		(request.hasFrom || request.hasTo);
	const [routeResult, reliabilityResult, historyResult] = await Promise.allSettled([
		getRoute(id, context),
		frameLive ? Promise.resolve(null) : getRouteReliability(id, context),
		selectedHistory
			? loadLineHistorySeed(id, request, { ...context, signal: event.request.signal })
			: Promise.resolve(null),
	]);
	const route = routeResult.status === 'fulfilled' ? routeResult.value : undefined;
	const directory = createLineDirectory(routesIndex?.routes ?? null, {
		line: (id) => routeNameFallback(id, lang),
	});
	const name = directory.name(id, route?.long);

	return {
		seed: { id, name: name.label },
		...(frameLive ? { frameLive } : {}),
		seoTitle: linePageTitle(name),
		routeSeed: routeResult.status === 'fulfilled' ? { key: id, data: routeResult.value } : null,
		reliabilitySeed:
			reliabilityResult.status === 'fulfilled' ? { key: id, data: reliabilityResult.value } : null,
		lineHistorySeed:
			historyResult.status === 'fulfilled' && historyResult.value?.result != null
				? historyResult.value
				: null,
	};
};
