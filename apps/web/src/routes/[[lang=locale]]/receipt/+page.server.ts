import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import {
	frameHref,
	frameDateLimit,
	frameClock,
	parseFrameState,
	periodError,
	presetPeriod,
	PRESETS,
	unpublishedYesterday,
} from '#lib/site/frameState.ts';
import { loadDailyRecord } from '#lib/server/departureDailyRecord.ts';
import { getScheduleEdition } from '#lib/server/engine.ts';
import { providerHasAlerts } from '#lib/site/providerCapabilities.ts';
import { dailyReportTitle } from '#lib/site/presenter.ts';

export const load: PageServerLoad = async (event) => {
	const { providerId, lang, provider, schedule } = await event.parent();
	const clock = frameClock(provider);
	const params = event.url.searchParams;
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
		? periodError(legacyPeriod, frameDateLimit(clock))
			? null
			: legacyPeriod
		: parseFrameState(params, clock).period;
	const unpublished = Boolean(unpublishedYesterday(period, clock));
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	const tracked = !provider || providerHasAlerts(provider);
	const lineNumbers = new Map(schedule?.routes.map(({ id, short }) => [id, short || id]));
	const scope = !unpublished &&
		period && {
			...period,
			city: providerId,
			visitorIp,
			fixtureScope: event.request.headers.get('x-transit-fixture-scope'),
		};
	const { sections, messagesLimited } = scope
		? loadDailyRecord(scope, tracked, lang, (id) => lineNumbers.get(id) ?? id)
		: { sections: [], messagesLimited: false };
	const ranking = sections.find(({ section }) => section === 'stops')?.answer;
	const directory = ranking?.then(async (result) => {
		if (result.kind !== 'answer' || !('rows' in result.answer) || !result.answer.rows.length)
			return [];
		const schedule = await getScheduleEdition(providerId, visitorIp);
		const ids = new Set(result.answer.rows.map(({ id }) => id));
		return schedule?.stops.filter(({ id }) => ids.has(id)) ?? [];
	});
	const title = period
		? dailyReportTitle(period, lang)
		: lang === 'fr'
			? 'Rapport quotidien'
			: 'Daily report';
	return {
		seoTitle: title,
		report: {
			title,
			lang,
			city: providerId,
			cityName: provider?.labels[lang].city ?? providerId,
			operator: provider?.labels[lang].operator,
			timeZone: provider?.timezone,
			period,
			unpublished,
			tracked,
			sections,
			messagesLimited,
			directory,
		},
	};
};
