import type { PageServerLoad } from './$types';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import { loadDailyRecord } from '#lib/server/departureDailyRecord.ts';
import { dailyReportFrame } from '#lib/site/dailyReportFrame.ts';

export const load: PageServerLoad = async (event) => {
	if (!dailyReportFrame(event.url)) return { report: null };
	const { period } = parseFrameState(event.url.searchParams, frameToday());
	const { providerId, lang, provider } = await event.parent();
	const scope = period && {
		...period,
		city: providerId,
		visitorIp: event.request.headers.get('cf-connecting-ip'),
	};
	return {
		report: {
			lang,
			city: providerId,
			cityName: provider?.labels[lang].city ?? providerId,
			period,
			...(scope ? loadDailyRecord(scope) : { sections: [], messagesLimited: false }),
		},
	};
};
