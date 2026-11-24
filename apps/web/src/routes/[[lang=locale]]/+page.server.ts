import { getMeasure, getRanking, getRecordAnswer, getScheduleEdition } from '#lib/server/engine.ts';
import { captureContext } from '#lib/live/captureContext.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import { overviewSelection } from '#lib/server/screenQuestions.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, parent, request, locals }) => {
	const { providerId: city, provider, lang, schedule } = await parent();
	const { mode, period } = parseFrameState(url.searchParams, frameToday(provider?.timezone));
	if (!period) return { record: null, liveRecord: null };

	const visitorIp = request.headers.get('cf-connecting-ip');
	const questions = overviewSelection({ ...period, city, visitorIp });
	const punctuality = getMeasure(...questions.punctuality);
	if (mode === 'live') return { record: null, liveRecord: { period, punctuality } };
	const stops = getRanking(...questions.stops);
	// On a client navigation the layout can be reused without running its server loader.
	const edition: ScheduleEdition | null | undefined =
		locals.overviewSchedule === undefined && provider
			? await getScheduleEdition(city, visitorIp)
			: locals.overviewSchedule;
	const directory = stops.then((ranked) => {
		if (!edition || ranked.kind !== 'answer') return [];
		const ids = new Set(ranked.answer.rows.map((row) => row.id));
		return edition.stops.filter((stop) => ids.has(stop.id));
	});
	return {
		liveRecord: null,
		record: {
			period,
			previous: questions.previous,
			punctuality,
			baseline: getMeasure(...questions.baseline),
			delivery: getMeasure(...questions.delivery),
			lines: getRanking(...questions.lines),
			stops,
			directory,
			totals: edition ? { lines: edition.routes.length, stops: edition.stops.length } : null,
			trend: getRecordAnswer(
				{ path: '/measure', parameters: { measure: 'on_time', group: 'day' } },
				questions.punctuality[1],
			),
			manifest: provider ? captureContext(provider, lang, schedule).manifest : null,
		},
	};
};
