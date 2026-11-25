import type { PageServerLoad } from './$types';
import { fetchCaptureSnapshot } from '#lib/live/captureSnapshot.ts';
import { getMethodCatalog, getRecordDataHealth, getScorecardAnswer } from '#lib/server/engine.ts';
import { healthDiagnosticQuestions } from '#lib/server/screenQuestions.ts';
import { calendarClock, parseAnswerFrameState } from '#lib/site/frameState.ts';

export const load = (async (event) => {
	const { providerId: city, provider } = await event.parent();
	// The calendar window includes recent dates even when their clean files are late.
	const { mode, period } = parseAnswerFrameState(event.url.searchParams, calendarClock(provider));
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	if (mode === 'record') {
		return {
			view: 'record' as const,
			record: period && {
				city,
				period,
				health: getRecordDataHealth({ ...period, city, visitorIp }),
				methods: getMethodCatalog(visitorIp),
			},
		};
	}
	return {
		view: 'live' as const,
		capture: provider
			? fetchCaptureSnapshot(city, event.request.signal, event.fetch).catch(() => null)
			: Promise.resolve(null),
		diagnostics: period && {
			period,
			city,
			sections: healthDiagnosticQuestions().map(({ measure, query }) => ({
				measure,
				answer: getScorecardAnswer(query, { ...period, city, visitorIp }),
			})),
		},
	};
}) satisfies PageServerLoad;
