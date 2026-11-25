import { directionHeadsigns } from '#lib/features/lines/directions.ts';
import { loadLineRecord, lineDirection } from '#lib/server/lineRecord.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import { lineFrameView } from '#lib/site/lineFrame.ts';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import { lineIsScheduleOnly } from '#lib/site/providerCapabilities.ts';
import { routeNameFallback } from '#lib/site/nameFallback.ts';
import { linePageTitle } from '#lib/seo/riderPageTitle.ts';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { canonicalDetailTabLocation, detailTabFromSearchParams } from '#lib/site/detailTabs.ts';
import { getRoute } from '#lib/v1/repositories/static.ts';
import { serverV1Context, type IdentitySeed } from '#lib/v1/serverContext.ts';

export const load: PageServerLoad = async (event) => {
	const canonicalLocation = canonicalDetailTabLocation(event.url);
	if (canonicalLocation) redirect(308, canonicalLocation);

	const id = event.params.id.trim() || event.params.id;
	const fallback: IdentitySeed = { id, name: id };
	const { url } = event;
	const tab = detailTabFromSearchParams(url.searchParams);
	if (tab === 'schedule') {
		const target = new URL(url);
		target.searchParams.delete('tab');
		target.searchParams.set('frameMode', 'record');
		redirect(308, target.pathname + target.search + '#schedule');
	}
	const view = lineFrameView(url);
	const frameLive = view === 'live';
	if (frameLive && (tab !== 'detail' || url.searchParams.get('frameMode') !== 'live')) {
		const live = new URL(url);
		live.searchParams.set('tab', 'detail');
		live.searchParams.set('frameMode', 'live');
		redirect(307, live.pathname + live.search);
	}

	const { v1, schedule, lang, providerId, provider } = await event.parent();
	const { period } = parseFrameState(url.searchParams, frameToday(provider?.timezone));
	if (!frameLive) {
		const directory = createLineDirectory(schedule?.routes ?? null, {
			line: (routeId) => routeNameFallback(routeId, lang),
			locale: lang,
			nameSeparators: provider?.name_separators,
		});
		const name = directory.name(id);
		const routeType = directory.type(id);
		const headsigns = directionHeadsigns(schedule?.route_directions?.[id]);
		const scheduleOnly = lineIsScheduleOnly(provider, id, routeType);
		const stops = (schedule?.stops ?? []).filter((stop) => stop.routes?.includes(id));
		return {
			seed: { id, name: name.label },
			scheduleOnly,
			directionHeadsigns: headsigns,
			stopNames: Object.fromEntries(stops.map((stop) => [stop.id, stop.name])),
			stopCodes: Object.fromEntries(
				stops.flatMap((stop) => (stop.code ? [[stop.id, stop.code]] : [])),
			),
			seoTitle: linePageTitle(name),
			record: period
				? loadLineRecord(
						period,
						providerId,
						id,
						lineDirection(url.searchParams),
						event.request.headers.get('cf-connecting-ip'),
						scheduleOnly,
					)
				: null,
			frameLive,
			routeSeed: null,
		};
	}
	if (!v1)
		return {
			seed: fallback,
			...(frameLive ? { frameLive } : {}),
			routeSeed: null,
		};
	const context = {
		...serverV1Context(event),
		providerId: v1.manifest.provider,
		manifest: v1.manifest,
	};
	const routeSeed = await getRoute(id, context).then(
		(data) => ({ key: id, data }),
		() => null,
	);
	const directory = createLineDirectory(schedule?.routes ?? null, {
		line: (id) => routeNameFallback(id, lang),
		locale: lang,
		nameSeparators: provider?.name_separators,
	});
	const name = directory.name(id, routeSeed?.data?.long);

	return {
		seed: { id, name: name.label },
		...(frameLive ? { frameLive } : {}),
		seoTitle: linePageTitle(name),
		routeSeed,
	};
};
