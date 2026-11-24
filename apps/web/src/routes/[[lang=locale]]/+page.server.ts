import { getMeasure, getRanking } from '#lib/server/engine.ts';
import { overviewSelection } from '#lib/server/screenQuestions.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, parent, request }) => {
	const { providerId: city, provider } = await parent();
	const { mode, period } = parseFrameState(url.searchParams, frameToday(provider?.timezone));
	if (!period) return { record: null, liveRecord: null };

	const visitorIp = request.headers.get('cf-connecting-ip');
	const questions = overviewSelection({ ...period, city, visitorIp });
	const punctuality = getMeasure(...questions.punctuality);
	if (mode === 'live') return { record: null, liveRecord: { period, punctuality } };
	return {
		liveRecord: null,
		record: {
			period,
			previous: questions.previous,
			punctuality,
			baseline: getMeasure(...questions.baseline),
			delivery: getMeasure(...questions.delivery),
			lines: getRanking(...questions.lines),
			stops: getRanking(...questions.stops),
		},
	};
};
