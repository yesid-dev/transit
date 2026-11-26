import type { PageServerLoad } from './$types';
import { fetchCaptureSnapshot } from '#lib/live/captureSnapshot.ts';
import {
	getMeasure,
	getMethodCatalog,
	getRecordDataHealth,
	getRecordMeasure,
	getRecordSeries,
	getScorecardAnswer,
} from '#lib/server/engine.ts';
import { agencyHealthQuestions } from '#lib/server/screenQuestions.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import { providerHasAlerts } from '#lib/site/providerCapabilities.ts';

export const load = (async (event) => {
	const { providerId: city, provider, lang } = await event.parent();
	// Data health reads the same last complete days as every other screen.
	const { mode, period } = parseAnswerFrameState(event.url.searchParams, frameClock(provider));
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	if (mode === 'record') {
		const alertsTracked = providerHasAlerts(provider);
		const scope = period && { ...period, city, visitorIp };
		const questions = agencyHealthQuestions();
		return {
			view: 'record' as const,
			alerts: { tracked: alertsTracked, officialUrl: provider?.alert_links[lang] },
			record: scope && {
				city,
				period: { from: scope.from, to: scope.to },
				coverage: getMeasure('punctuality', scope),
				accessibility: getRecordMeasure(questions.accessibility, scope),
				alertEffects: alertsTracked ? getRecordSeries(questions.alertEffects, scope) : null,
				scorecard: Object.fromEntries(
					questions.scorecard.map(({ measure, query }) => [
						measure,
						getScorecardAnswer(query, scope),
					]),
				) as Record<
					(typeof questions.scorecard)[number]['measure'],
					ReturnType<typeof getScorecardAnswer>
				>,
				health: getRecordDataHealth(scope),
				methods: getMethodCatalog(visitorIp),
			},
		};
	}
	return {
		view: 'live' as const,
		capture: provider
			? fetchCaptureSnapshot(city, event.request.signal, event.fetch).catch(() => null)
			: Promise.resolve(null),
	};
}) satisfies PageServerLoad;
