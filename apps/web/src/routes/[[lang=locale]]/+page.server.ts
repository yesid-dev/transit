import { getMeasure, getRanking } from '#lib/server/engine.ts';
import { overviewSelection } from '#lib/server/screenQuestions.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, parent, request }) => {
	const { mode, period } = parseFrameState(url.searchParams, frameToday());
	if (mode === 'live' || !period) return { record: null };

	const { providerId: city } = await parent();
	const visitorIp = request.headers.get('cf-connecting-ip');
	const questions = overviewSelection({ ...period, city, visitorIp });
	return {
		record: {
			period,
			previous: questions.previous,
			punctuality: getMeasure(...questions.punctuality),
			baseline: getMeasure(...questions.baseline),
			delivery: getMeasure(...questions.delivery),
			lines: getRanking(...questions.lines),
			stops: getRanking(...questions.stops),
		},
	};
};
