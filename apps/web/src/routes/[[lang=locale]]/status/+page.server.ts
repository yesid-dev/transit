import type { PageServerLoad } from './$types';
import { fetchCaptureSnapshot } from '#lib/live/captureSnapshot.ts';
import { readHealthRecord } from '#lib/server/healthRecord.ts';
import type { Complete } from '#lib/server/readingFilter.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import { providerHasAlerts } from '#lib/site/providerCapabilities.ts';
import { readyAnswers, streamed } from '#lib/server/readyAnswers.ts';

export const load = (async (event) => {
	const { providerId: city, provider, lang } = await event.parent();
	// Data health reads the same last complete days as every other screen.
	const { mode, period } = parseAnswerFrameState(event.url.searchParams, frameClock(provider));
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	const alerts = { tracked: providerHasAlerts(provider), officialUrl: provider?.alert_links[lang] };
	if (mode === 'record') {
		const scope = period && { ...period, city, visitorIp };
		return readyAnswers({
			view: 'record' as const,
			alerts,
			record: scope && {
				city,
				period: { from: scope.from, to: scope.to },
				...(readHealthRecord(scope, alerts.tracked) as Complete<
					ReturnType<typeof readHealthRecord>
				>),
			},
		});
	}
	return readyAnswers({
		view: 'live' as const,
		alerts,
		capture: provider
			? streamed(fetchCaptureSnapshot(city, event.request.signal, event.fetch).catch(() => null))
			: Promise.resolve(null),
	});
}) satisfies PageServerLoad;
