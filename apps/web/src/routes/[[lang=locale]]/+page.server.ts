import { getScheduleEdition } from '#lib/server/engine.ts';
import { captureContext } from '#lib/live/captureContext.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import type { Complete } from '#lib/server/readingFilter.ts';
import { readOverviewRecord } from '#lib/server/overviewRecord.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, parent, request, locals }) => {
	const { providerId: city, provider, lang, schedule } = await parent();
	const { mode, period } = parseAnswerFrameState(url.searchParams, frameClock(provider));
	if (!period) return { mode, record: null };

	const visitorIp = request.headers.get('cf-connecting-ip');
	// On a client navigation the layout can be reused without running its server loader.
	const edition = (): ScheduleEdition | Promise<ScheduleEdition | null> | null =>
		locals.overviewSchedule === undefined && provider
			? getScheduleEdition(city, visitorIp)
			: (locals.overviewSchedule ?? null);
	const readings = readOverviewRecord({ ...period, city, visitorIp }, edition) as Complete<
		ReturnType<typeof readOverviewRecord>
	>;
	return {
		mode,
		record: {
			period,
			...readings,
			manifest: provider ? captureContext(provider, lang, schedule).manifest : null,
		},
	};
};
