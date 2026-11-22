import { getMeasure, getRanking } from '#lib/server/engine.ts';
import { previousPeriod } from '#lib/features/home/overviewRecord.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, parent }) => {
	const { mode, period } = parseFrameState(url.searchParams, frameToday());
	if (mode === 'live' || !period) return { record: null };

	const { providerId: city } = await parent();
	const previous = previousPeriod(period);
	return {
		record: {
			period,
			previous,
			punctuality: getMeasure('on_time', { ...period, city }),
			baseline: getMeasure('on_time', { ...previous, city }),
			delivery: getMeasure('trips_run', { ...period, city }),
			lines: getRanking('line', { ...period, city }),
			stops: getRanking('stop', { ...period, city }),
		},
	};
};
