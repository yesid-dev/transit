import { providerHasAlerts } from '#lib/site/providerCapabilities.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import { loadAlertRecord } from '#lib/server/alertRecord.ts';
import { fetchCaptureSnapshot } from '#lib/live/captureSnapshot.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { providerId, lang, provider } = await event.parent();
	const clock = frameClock(provider);
	const { mode, period } = parseAnswerFrameState(event.url.searchParams, clock);
	const tracked = providerHasAlerts(provider);
	return {
		alertRecord: {
			mode,
			period,
			downloadPeriod: period ?? parseAnswerFrameState(new URLSearchParams(), clock).period,
			tracked,
			officialAlertsUrl: provider?.alert_links[lang],
			city: providerId,
			timeZone: provider?.timezone,
			cityName: provider?.labels[lang].city ?? providerId,
			operator: provider?.labels[lang].operator,
			capture:
				mode === 'live' && tracked
					? fetchCaptureSnapshot(providerId, event.request.signal, event.fetch).catch(() => null)
					: null,
			sections:
				mode === 'record' && tracked && period
					? loadAlertRecord({
							...period,
							city: providerId,
							visitorIp: event.request.headers.get('cf-connecting-ip'),
						})
					: [],
		},
	};
};
