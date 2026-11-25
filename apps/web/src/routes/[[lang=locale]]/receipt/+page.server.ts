import type { PageServerLoad } from './$types';
import { frameDateLimit, frameToday, parseFrameState, periodError } from '#lib/site/frameState.ts';
import { loadDailyRecord } from '#lib/server/departureDailyRecord.ts';

export const load: PageServerLoad = async (event) => {
	const { providerId, lang, provider } = await event.parent();
	const today = frameToday(provider?.timezone);
	const date = event.url.searchParams.has('recordFrom') ? null : event.url.searchParams.get('date');
	const legacyPeriod = date == null ? null : { from: date, to: date, preset: null };
	const period = legacyPeriod
		? periodError(legacyPeriod, frameDateLimit(today, provider?.record_through))
			? null
			: legacyPeriod
		: parseFrameState(event.url.searchParams, today, provider?.record_through).period;
	const scope = period && {
		...period,
		city: providerId,
		visitorIp: event.request.headers.get('cf-connecting-ip'),
		fixtureScope: event.request.headers.get('x-transit-fixture-scope'),
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
