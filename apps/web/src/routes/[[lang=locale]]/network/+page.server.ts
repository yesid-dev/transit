import type { PageServerLoad } from './$types';
import { fetchCaptureSnapshot } from '#lib/live/captureSnapshot.ts';
import { loadNetworkRecord } from '#lib/server/networkRecord.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import { networkRecordView } from '#lib/site/networkFrame.ts';
import { readyAnswers, streamed } from '#lib/server/readyAnswers.ts';

export const load: PageServerLoad = async (event) => {
	const { providerId: city, provider } = await event.parent();
	if (!networkRecordView(event.url)) {
		return readyAnswers({
			view: 'live' as const,
			capture: provider?.inputs.vehicle_positions
				? streamed(fetchCaptureSnapshot(city, event.request.signal, event.fetch).catch(() => null))
				: Promise.resolve(null),
		});
	}

	const { period } = parseAnswerFrameState(event.url.searchParams, frameClock(provider));
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	return readyAnswers({
		view: 'record' as const,
		networkRecord: period && loadNetworkRecord({ ...period, city, visitorIp }),
	});
};
