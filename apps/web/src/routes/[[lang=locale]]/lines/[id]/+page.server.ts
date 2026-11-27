import { directionHeadsigns } from '#lib/features/lines/directions.ts';
import { loadLineRecord, lineDirection } from '#lib/server/lineRecord.ts';
import { archivedIdentity, validEntityId } from '#lib/server/entityIdentity.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import { lineFrameView } from '#lib/site/lineFrame.ts';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import { lineIsScheduleOnly, providerHasAlerts } from '#lib/site/providerCapabilities.ts';
import { routeNameFallback } from '#lib/site/nameFallback.ts';
import { linePageTitle } from '#lib/seo/riderPageTitle.ts';
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { canonicalDetailTabLocation, detailTabFromSearchParams } from '#lib/site/detailTabs.ts';
import { fetchCaptureSnapshot, fetchCaptureTripScope } from '#lib/live/captureSnapshot.ts';
import { selectMainStops } from '#lib/features/lines/lineLiveReadings.ts';
import { uniqueDirectionHeadsigns } from '#lib/live/stopPrediction.ts';

export const load: PageServerLoad = async (event) => {
	const { url } = event;
	const canonicalLocation = canonicalDetailTabLocation(url);
	if (canonicalLocation) redirect(308, canonicalLocation);

	const id = event.params.id;
	if (!validEntityId(id)) error(404);
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

	const { schedule, lang, providerId, provider, patterns } = await event.parent();
	const knownLine = schedule?.routes.some((route) => route.id === id) ?? false;
	const clock = frameClock(provider);
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	if (!knownLine) {
		const identity = await archivedIdentity('line', id, clock, { city: providerId, visitorIp });
		if (identity === 'missing' && schedule)
			error(404, lang === 'fr' ? 'Cette ligne est introuvable.' : 'This line could not be found.');
		if (identity !== 'available')
			error(
				503,
				lang === 'fr'
					? 'Cette ligne est temporairement indisponible.'
					: 'This line is temporarily unavailable.',
			);
	}
	const outsideCurrentTimetable = schedule != null && !knownLine;
	const showLiveReadings = frameLive && !outsideCurrentTimetable;
	const directory = createLineDirectory(schedule?.routes ?? null, {
		line: (routeId) => routeNameFallback(routeId, lang),
		locale: lang,
		nameSeparators: provider?.name_separators,
		patterns,
	});
	const name = directory.name(id);
	const directions = schedule?.route_directions?.[id];
	const riderDirections = directions?.map((direction) => ({
		...direction,
		headsign: directory.headsign(id, direction.headsign),
	}));
	const scheduleOnly =
		!outsideCurrentTimetable &&
		(lineIsScheduleOnly(provider, id, directory.type(id)) ||
			(frameLive &&
				provider?.inputs.vehicle_positions === false &&
				provider.inputs.trip_updates === false));
	const stops = (schedule?.stops ?? []).filter((stop) => stop.routes?.includes(id));
	const { period } = parseAnswerFrameState(url.searchParams, clock);
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
		directionHeadsigns: directionHeadsigns(riderDirections),
		predictionHeadsigns: uniqueDirectionHeadsigns(riderDirections),
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
										? ['frequency', 'directionalFrequency', 'boundaries']
										: ['frequency', 'directionalFrequency', 'boundaries', 'punctuality'],
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
