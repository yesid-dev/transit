import { stopDisplayName } from '#lib/site/transitDisplay.ts';
import { stopPageTitle } from '#lib/seo/riderPageTitle.ts';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { canonicalDetailTabLocation } from '#lib/site/detailTabs.ts';
import { loadStopRecord } from '#lib/server/stopRecord.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
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
	const { lang, providerId, schedule, provider } = await event.parent();
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
	const period = !frameLive
		? parseAnswerFrameState(url.searchParams, frameClock(provider)).period
		: null;
	return {
		seed: { id, name: name || id },
		stopCode: scheduledStop?.code,
		stopLines: lines,
		outsideCurrentTimetable,
		frameLive,
		scheduleOnly,
		tripUpdatesPublished,
		hasAlerts,
		...(name ? { seoTitle: stopPageTitle(stopDisplayName(name), scheduledStop?.code, lang) } : {}),
		record: period
			? loadStopRecord(
					{ ...period, city: providerId, visitorIp: event.request.headers.get('cf-connecting-ip') },
					id,
				)
			: null,
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
