import { providerHasAlerts } from '#lib/v1/providers.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import { loadAlertRecord } from '#lib/server/alertRecord.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { mode, period } = parseFrameState(event.url.searchParams, frameToday());
	if (mode === 'live') return { alertRecord: null };
	const { providerId, lang, provider } = await event.parent();
	const tracked = providerHasAlerts(provider);
	return {
		alertRecord: {
			period,
			tracked,
			officialAlertsUrl: provider?.alert_links[lang],
			city: providerId,
			cityName: provider?.labels[lang].city ?? providerId,
			sections:
				tracked && period
					? loadAlertRecord({
							...period,
							city: providerId,
							visitorIp: event.request.headers.get('cf-connecting-ip'),
						})
					: [],
		},
	};
};
