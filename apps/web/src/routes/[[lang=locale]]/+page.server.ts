import { getMeasure, getRanking } from '#lib/server/engine.ts';
import { previousPeriod } from '#lib/features/home/overviewRecord.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, parent, request }) => {
	const { mode, period } = parseFrameState(url.searchParams, frameToday());
	if (mode === 'live' || !period) return { record: null };

	const { providerId: city } = await parent();
	const previous = previousPeriod(period);
	const visitorIp = request.headers.get('cf-connecting-ip');
	const scope = { ...period, city, visitorIp };
	return {
		record: {
			period,
			previous,
			punctuality: getMeasure('on_time', scope),
			baseline: getMeasure('on_time', { ...previous, city, visitorIp }),
			delivery: getMeasure('trips_run', scope),
			lines: getRanking('line', scope),
			stops: getRanking('stop', scope),
		},
	};
};
