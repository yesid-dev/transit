import { env } from 'cloudflare:workers';
import type { PageServerLoad } from './$types';
import { fetchCaptureSnapshot } from '#lib/live/captureSnapshot.ts';
import { loadNetworkRecord } from '#lib/server/networkRecord.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import { networkRecordView } from '#lib/site/networkFrame.ts';

export const load: PageServerLoad = async (event) => {
	const { providerId: city, provider } = await event.parent();
	if (!networkRecordView(event.url)) {
		const fixtureClock =
			env.QUESTION_FIXTURE_ORIGIN && !env.QUESTION_PROXY && env.CAPTURE_FIXTURE_CLOCK
				? Date.parse(env.CAPTURE_FIXTURE_CLOCK)
				: NaN;
		return {
			view: 'live' as const,
			captureClock: Number.isFinite(fixtureClock) ? fixtureClock : undefined,
			capture: provider?.inputs.vehicle_positions
				? fetchCaptureSnapshot(city, event.request.signal, event.fetch).catch(() => null)
				: Promise.resolve(null),
		};
	}

	const { period } = parseAnswerFrameState(event.url.searchParams, frameClock(provider));
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	return {
		view: 'record' as const,
		networkRecord: period && loadNetworkRecord({ ...period, city, visitorIp }),
	};
};
