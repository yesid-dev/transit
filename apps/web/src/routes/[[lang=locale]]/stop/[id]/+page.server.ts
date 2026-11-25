import { stopDisplayName } from '#lib/site/transitDisplay.ts';
import { stopPageTitle } from '#lib/seo/riderPageTitle.ts';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { canonicalDetailTabLocation } from '#lib/site/detailTabs.ts';
import { getStop } from '#lib/v1/repositories/static.ts';
import { serverV1Context, type IdentitySeed } from '#lib/v1/serverContext.ts';
import { loadStopRecord } from '#lib/server/stopRecord.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import { stopFrameView, stopViewHref } from '#lib/site/stopFrame.ts';

export const load: PageServerLoad = async (event) => {
	const canonicalLocation = canonicalDetailTabLocation(event.url);
	if (canonicalLocation) redirect(308, canonicalLocation);

	const view = stopFrameView(event.url);
	const frameLive = view === 'live';
	if (
		frameLive &&
		(event.url.searchParams.get('tab') !== 'detail' ||
			event.url.searchParams.get('frameMode') !== 'live')
	) {
		const live = stopViewHref(event.url, 'live');
		redirect(307, live.pathname + live.search);
	}

	const id = event.params.id.trim() || event.params.id;
	const fallback: IdentitySeed = { id, name: id };
	const { v1, lang, providerId, schedule, provider } = await event.parent();
	const period =
		view === 'record'
			? parseAnswerFrameState(event.url.searchParams, frameClock(provider)).period
			: null;
	const scheduledStop = schedule?.stops.find((stop) => stop.id === id);
	const frame = period
		? {
				record: loadStopRecord(
					{ ...period, city: providerId, visitorIp: event.request.headers.get('cf-connecting-ip') },
					id,
				),
			}
		: frameLive
			? { frameLive }
			: {};
	if (!frameLive) {
		const name = scheduledStop?.name.trim();
		return {
			...frame,
			seed: name ? { id, name } : fallback,
			stopSeed: null,
			stopCode: scheduledStop?.code,
			stopLines: scheduledStop?.routes,
			...(name
				? { seoTitle: stopPageTitle(stopDisplayName(name), scheduledStop?.code, lang) }
				: {}),
		};
	}
	if (!v1) return { ...frame, seed: fallback, stopSeed: null };

	try {
		const stop = await getStop(id, {
			...serverV1Context(event),
			providerId: v1.manifest.provider,
			manifest: v1.manifest,
		});
		const name = stop?.name.trim();
		return {
			...frame,
			seed: name ? { id, name } : fallback,
			stopSeed: { key: id, data: stop },
			...(name ? { seoTitle: stopPageTitle(stopDisplayName(name), stop?.code, lang) } : {}),
		};
	} catch {
		return { ...frame, seed: fallback, stopSeed: null };
	}
};
