import { directionHeadsigns } from '#lib/features/lines/directions.ts';
import { loadLineRecord, lineDirection } from '#lib/server/lineRecord.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import { lineFrameView } from '#lib/site/lineFrame.ts';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import { lineIsScheduleOnly, providerHasAlerts } from '#lib/site/providerCapabilities.ts';
import { routeNameFallback } from '#lib/site/nameFallback.ts';
import { linePageTitle } from '#lib/seo/riderPageTitle.ts';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { canonicalDetailTabLocation, detailTabFromSearchParams } from '#lib/site/detailTabs.ts';
import { fetchCaptureSnapshot, fetchCaptureTripScope } from '#lib/live/captureSnapshot.ts';
import { selectMainStops } from '#lib/features/lines/lineLiveReadings.ts';

export const load: PageServerLoad = async (event) => {
	const { url } = event;
	const canonicalLocation = canonicalDetailTabLocation(url);
	if (canonicalLocation) redirect(308, canonicalLocation);

	const id = event.params.id.trim() || event.params.id;
	const tab = detailTabFromSearchParams(url.searchParams);
	if (tab === 'schedule') {
		const target = new URL(url);
		target.searchParams.delete('tab');
		target.searchParams.set('frameMode', 'record');
		redirect(308, target.pathname + target.search + '#schedule');
	}
	const frameLive = lineFrameView(url) === 'live';
	if (tab === 'detail') {
		const target = new URL(url);
		target.searchParams.delete('tab');
		target.searchParams.set('frameMode', 'live');
		redirect(308, target.pathname + target.search);
	}

	const { schedule, lang, providerId, provider } = await event.parent();
	const knownLine = schedule?.routes.some((route) => route.id === id) ?? false;
	const outsideCurrentTimetable = schedule != null && !knownLine;
	const showLiveReadings = frameLive && !outsideCurrentTimetable;
	const directory = createLineDirectory(schedule?.routes ?? null, {
		line: (routeId) => routeNameFallback(routeId, lang),
		locale: lang,
		nameSeparators: provider?.name_separators,
	});
	const name = directory.name(id);
	const directions = schedule?.route_directions?.[id];
	const scheduleOnly =
		!outsideCurrentTimetable &&
		(lineIsScheduleOnly(provider, id, directory.type(id)) ||
			(frameLive &&
				provider?.inputs.vehicle_positions === false &&
				provider.inputs.trip_updates === false));
	const stops = (schedule?.stops ?? []).filter((stop) => stop.routes?.includes(id));
	const { period } = parseAnswerFrameState(url.searchParams, frameClock(provider));
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	const canPredict = !!provider?.inputs.trip_updates && !scheduleOnly;
	const capture =
		showLiveReadings && !scheduleOnly && provider
			? fetchCaptureSnapshot(providerId, event.request.signal, event.fetch).catch(() => null)
			: null;
	return {
		seed: { id, name: name.label },
		knownLine,
		outsideCurrentTimetable,
		scheduleOnly,
		directionHeadsigns: directionHeadsigns(directions),
		stopNames: Object.fromEntries(stops.map((stop) => [stop.id, stop.name])),
		stopCodes: Object.fromEntries(
			stops.flatMap((stop) => (stop.code ? [[stop.id, stop.code]] : [])),
		),
		seoTitle: linePageTitle(name),
		record:
			period && (!frameLive || showLiveReadings)
				? loadLineRecord(
						period,
						providerId,
						id,
						lineDirection(url.searchParams),
						visitorIp,
						scheduleOnly,
						frameLive
							? new Set(
									scheduleOnly
										? ['frequency', 'boundaries']
										: ['frequency', 'boundaries', 'punctuality'],
								)
							: undefined,
					)
				: null,
		frameLive,
		capture,
		canPredict,
		mainStops: showLiveReadings && !scheduleOnly ? selectMainStops(stops, directions ?? []) : [],
		trips:
			showLiveReadings && canPredict
				? fetchCaptureTripScope(
						providerId,
						{ kind: 'line', id },
						event.request.signal,
						event.fetch,
					).catch(() => null)
				: null,
		hasAlerts: providerHasAlerts(provider),
	};
};
