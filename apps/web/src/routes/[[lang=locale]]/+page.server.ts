import { getMeasure, getRanking, getRecordAnswer, getScheduleEdition } from '#lib/server/engine.ts';
import { captureContext } from '#lib/live/captureContext.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import { overviewSelection } from '#lib/server/screenQuestions.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import type { PageServerLoad } from './$types';

function scheduleTotals(edition: ScheduleEdition | null) {
	return edition ? { lines: edition.routes.length, stops: edition.stops.length } : null;
}

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
	const edition: ScheduleEdition | Promise<ScheduleEdition | null> | null =
		locals.overviewSchedule === undefined && provider
			? getScheduleEdition(city, visitorIp)
			: (locals.overviewSchedule ?? null);
	const directory = Promise.all([edition, stops]).then(([schedule, ranked]) => {
		if (!schedule || ranked.kind !== 'answer') return [];
		const ids = new Set(ranked.answer.rows.map((row) => row.id));
		return schedule.stops.filter((stop) => ids.has(stop.id));
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
			totals: edition instanceof Promise ? edition.then(scheduleTotals) : scheduleTotals(edition),
			trend: getRecordAnswer(...questions.trend),
			manifest: provider ? captureContext(provider, lang, schedule).manifest : null,
		},
	};
};
