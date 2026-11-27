import { stopDisplayName } from '#lib/site/transitDisplay.ts';
import { stopPageTitle } from '#lib/seo/riderPageTitle.ts';
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { canonicalDetailTabLocation } from '#lib/site/detailTabs.ts';
import { loadStopRecord } from '#lib/server/stopRecord.ts';
import {
	archivedIdentity,
	validEntityId,
	type EntityIdentity,
} from '#lib/server/entityIdentity.ts';
import { withinBootBudget } from '#lib/server/timetable.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import { stopFrameView, stopViewHref } from '#lib/site/stopFrame.ts';
import { lineIsScheduleOnly, providerHasAlerts } from '#lib/site/providerCapabilities.ts';
import { fetchCaptureSnapshot, fetchCaptureTripScope } from '#lib/live/captureSnapshot.ts';

export const load: PageServerLoad = async (event) => {
	const started = performance.now();
	const { url } = event;
	const canonicalLocation = canonicalDetailTabLocation(url);
	if (canonicalLocation) redirect(308, canonicalLocation);

	const frameLive = stopFrameView(url) === 'live';
	if (url.searchParams.get('tab') === 'detail') {
		const live = stopViewHref(url, 'live');
		redirect(308, live.pathname + live.search);
	}

	const id = event.params.id;
	if (!validEntityId(id)) error(404);
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
	let stopIdentity: Promise<EntityIdentity> | undefined;
	if (!scheduledStop) {
		const identity = schedule && archivedIdentity('stop', id, clock, scope);
		const fast = identity ? await withinBootBudget(identity, started) : 'unconfirmed';
		if (fast === 'missing') {
			error(404, {
				code: 'STOP_NOT_FOUND',
				message: lang === 'fr' ? 'Cet arrêt est introuvable.' : 'This stop could not be found.',
			});
		}
		if (fast === 'unconfirmed')
			error(
				503,
				lang === 'fr'
					? 'Cet arrêt est temporairement indisponible.'
					: 'This stop is temporarily unavailable.',
			);
		if (identity && fast === undefined) stopIdentity = identity;
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
		stopIdentity,
		record: period ? loadStopRecord({ ...scope, ...period }, id, undefined, stopIdentity) : null,
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
