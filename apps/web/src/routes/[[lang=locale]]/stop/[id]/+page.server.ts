import { stopDisplayName } from '#lib/site/transitDisplay.ts';
import { stopPageTitle } from '#lib/seo/riderPageTitle.ts';
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { canonicalDetailTabLocation } from '#lib/site/detailTabs.ts';
import { loadStopRecord } from '#lib/server/stopRecord.ts';
import { getRecordAnswer } from '#lib/server/engine.ts';
import {
	frameClock,
	frameDateLimit,
	MAX_RECORD_DAYS,
	parseAnswerFrameState,
	RECORD_START,
} from '#lib/site/frameState.ts';
import { stopFrameView, stopViewHref } from '#lib/site/stopFrame.ts';
import { lineIsScheduleOnly, providerHasAlerts } from '#lib/site/providerCapabilities.ts';
import { fetchCaptureSnapshot, fetchCaptureTripScope } from '#lib/live/captureSnapshot.ts';

export const load: PageServerLoad = async (event) => {
	const { url } = event;
	const canonicalLocation = canonicalDetailTabLocation(url);
	if (canonicalLocation) redirect(308, canonicalLocation);

	const frameLive = stopFrameView(url) === 'live';
	if (url.searchParams.get('tab') === 'detail') {
		const live = stopViewHref(url, 'live');
		redirect(308, live.pathname + live.search);
	}

	const id = event.params.id.trim() || event.params.id;
	const { lang, providerId, schedule, provider, patterns } = await event.parent();
	const scheduledStop = schedule?.stops.find((stop) => stop.id === id);
	const outsideCurrentTimetable = schedule != null && !scheduledStop;
	const name = scheduledStop?.name.trim();
	const lines = scheduledStop?.routes ?? [];
	const scheduleOnly =
		lines.length > 0 &&
		lines.every((line) =>
			lineIsScheduleOnly(
				provider,
				line,
				schedule?.routes.find((route) => route.id === line)?.type ?? null,
			),
		);
	const hasAlerts = providerHasAlerts(provider);
	const tripUpdatesPublished = provider?.inputs.trip_updates !== false;
	const live = frameLive && !outsideCurrentTimetable && provider;
	const signal = event.request.signal;
	const clock = frameClock(provider);
	const period = !frameLive ? parseAnswerFrameState(url.searchParams, clock).period : null;
	const scope = { city: providerId, visitorIp: event.request.headers.get('cf-connecting-ip') };
	if (period && !scheduledStop) {
		// One question over the whole record tells an archived stop, which keeps its Record even
		// for dates without readings, from an id the network never published.
		const to = frameDateLimit(clock);
		const start = clock.recordStart ?? RECORD_START;
		const earliest = new Date(Date.parse(to) - (MAX_RECORD_DAYS - 1) * 86_400_000)
			.toISOString()
			.slice(0, 10);
		const history = await getRecordAnswer(
			{ path: '/measure', parameters: { measure: 'on_time', group: 'stop_id', stop: id } },
			{ ...scope, from: earliest > start ? earliest : start, to },
		);
		const unavailable = () =>
			error(
				503,
				lang === 'fr'
					? 'L’identité de cet arrêt est temporairement indisponible.'
					: 'This stop’s identity is temporarily unavailable.',
			);
		if (history.kind !== 'answer' || !('cells' in history.answer)) return unavailable();
		if (!history.answer.cells.some(({ key }) => key.stop === id)) {
			if (!schedule || !history.answer.evidence.days_included.length) return unavailable();
			error(404, {
				code: 'STOP_NOT_FOUND',
				message: lang === 'fr' ? 'Cet arrêt est introuvable.' : 'This stop could not be found.',
			});
		}
	}
	return {
		seed: { id, name: name || id },
		stopCode: scheduledStop?.code,
		stopLines: lines,
		// Only this stop's lines, read by the layout from the whole timetable: their termini name
		// where a compass headsign goes.
		linePatterns: patterns,
		outsideCurrentTimetable,
		frameLive,
		scheduleOnly,
		tripUpdatesPublished,
		hasAlerts,
		...(name ? { seoTitle: stopPageTitle(stopDisplayName(name), scheduledStop?.code, lang) } : {}),
		record: period ? loadStopRecord({ ...scope, ...period }, id) : null,
		capture:
			live && (hasAlerts || (tripUpdatesPublished && !scheduleOnly))
				? fetchCaptureSnapshot(providerId, signal, event.fetch).catch(() => null)
				: null,
		trips:
			live && tripUpdatesPublished && !scheduleOnly
				? fetchCaptureTripScope(providerId, { kind: 'stop', id }, signal, event.fetch).catch(
						() => null,
					)
				: null,
	};
};
