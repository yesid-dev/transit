import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import {
	frameHref,
	frameDateLimit,
	frameClock,
	parseAnswerFrameState,
	periodError,
	presetPeriod,
	PRESETS,
	receiptFrameParams,
} from '#lib/site/frameState.ts';
import { dailyDirectory, loadDailyRecord } from '#lib/server/departureDailyRecord.ts';
import { getScheduleEdition } from '#lib/server/engine.ts';
import { providerHasAlerts } from '#lib/site/providerCapabilities.ts';
import { dailyReportTitle } from '#lib/site/presenter.ts';
import { readyAnswers } from '#lib/server/readyAnswers.ts';

export const load: PageServerLoad = async (event) => {
	const { providerId, lang, provider, schedule } = await event.parent();
	const clock = frameClock(provider);
	const params = receiptFrameParams(event.url.searchParams, clock);
	const date = params.has('recordFrom') ? null : params.get('date');
	const legacyPeriod = date == null ? null : { from: date, to: date, preset: null };
	if (!legacyPeriod && !params.has('recordFrom') && !params.has('recordTo')) {
		const preset = PRESETS.find((value) => value === params.get('period'));
		const latest = presetPeriod('7-days', clock)?.to ?? presetPeriod('12-months', clock)?.to;
		const yesterday = presetPeriod('yesterday', clock);
		const period = preset
			? presetPeriod(preset, clock)
			: latest
				? { from: latest, to: latest, preset: null }
				: yesterday && { ...yesterday, preset: null };
		// Pin implicit dates so the report and the shared controls agree.
		if (period) redirect(307, frameHref(event.url, { mode: 'record', period }));
	}
	const period = legacyPeriod
		? periodError(legacyPeriod, frameDateLimit(clock), clock.recordStart)
			? null
			: legacyPeriod
		: parseAnswerFrameState(params, clock).period;
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	const tracked = !provider || providerHasAlerts(provider);
	const lineNumbers = new Map(schedule?.routes.map(({ id, short }) => [id, short || id]));
	const scope = period && {
		...period,
		city: providerId,
		visitorIp,
	};
	const { sections, messagesLimited } = scope
		? loadDailyRecord(scope, tracked, lang, (id) => lineNumbers.get(id) ?? id)
		: { sections: [], messagesLimited: false };
	const directory = dailyDirectory(
		sections.find(({ section }) => section === 'stops')?.answer,
		() => getScheduleEdition(providerId, visitorIp),
	);
	const title = period
		? dailyReportTitle(period, lang)
		: lang === 'fr'
			? 'Rapport quotidien'
			: 'Daily report';
	return readyAnswers({
		seoTitle: title,
		report: {
			title,
			lang,
			city: providerId,
			cityName: provider?.labels[lang].city ?? providerId,
			operator: provider?.labels[lang].operator,
			timeZone: provider?.timezone,
			period,
			tracked,
			sections,
			messagesLimited,
			directory,
		},
	});
};
