import { directionHeadsigns } from '#lib/features/lines/directions.ts';
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import {
	canonicalDepartureHref,
	departureFromKey,
	isDepartureTripId,
} from '#lib/features/record/departureIdentity.ts';
import {
	departureDay,
	identifyDeparture,
	loadDepartureLive,
	loadDepartureRecord,
	publishedDepartureTrip,
} from '#lib/server/departureDailyRecord.ts';
import { scheduledClock } from '#lib/site/presenter.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import { detailNotFoundCopy } from '#lib/site/errorPage.ts';
import { localizeHref } from '#lib/i18n/index.ts';
import { validEntityId } from '#lib/server/entityIdentity.ts';
import { READY_WAIT_MS, readyAnswers, streamed } from '#lib/server/readyAnswers.ts';
import { captureDisplayState, fetchCaptureTripScope } from '#lib/live/captureSnapshot.ts';

export const load: PageServerLoad = async (event) => {
	const { providerId, lang, v1, schedule, provider } = await event.parent();
	const identity = departureFromKey(event.params.key);
	const requestedTrip = event.url.searchParams.get('trip');
	const onlyTrip =
		event.params.key === 'trip' && isDepartureTripId(requestedTrip) ? requestedTrip : null;
	if (!identity && !onlyTrip)
		error(404, detailNotFoundCopy.DEPARTURE_NOT_FOUND[lang].heading, {
			code: 'DEPARTURE_NOT_FOUND',
		});
	const clock = frameClock(provider);
	const { today } = clock;
	const { period, mode } = parseAnswerFrameState(event.url.searchParams, clock);
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	const day = period ? departureDay(event.url.searchParams, period) : today;
	const scope = { city: providerId, visitorIp };
	const line = identity
		? schedule?.routes.find(({ id }) => id === identity.line)?.short || identity.line
		: null;
	const time = identity ? scheduledClock(identity.departure, lang) : null;
	const unavailable = () =>
		error(
			503,
			lang === 'fr'
				? 'Ce départ est temporairement indisponible.'
				: 'This departure is temporarily unavailable.',
		);
	if (onlyTrip) {
		if (mode !== 'live')
			error(404, detailNotFoundCopy.DEPARTURE_NOT_FOUND[lang].heading, {
				code: 'DEPARTURE_NOT_FOUND',
			});
		const report = await fetchCaptureTripScope(
			providerId,
			{ kind: 'trip', id: onlyTrip },
			event.request.signal,
			event.fetch,
		).catch(() => null);
		if (!report || captureDisplayState(report.feed, Date.now()) !== 'live') return unavailable();
		if (!report.trip_updates.some(({ trip_id }) => trip_id === onlyTrip))
			error(404, detailNotFoundCopy.DEPARTURE_NOT_FOUND[lang].heading, {
				code: 'DEPARTURE_NOT_FOUND',
			});
	}
	if (identity) {
		const state = validEntityId(identity.line)
			? await identifyDeparture(identity, clock, scope)
			: 'missing';
		const liveMatch =
			state !== 'available' &&
			mode === 'live' &&
			requestedTrip &&
			v1 &&
			(await publishedDepartureTrip(providerId, requestedTrip, identity, visitorIp));
		if (state === 'missing' && !liveMatch)
			error(
				404,
				lang === 'fr'
					? `Aucun départ de ${time} n’est prévu sur la ligne ${line}.`
					: `No ${time} departure is scheduled on line ${line}.`,
				{
					code: 'DEPARTURE_NOT_FOUND',
					line: localizeHref(`/lines/${encodeURIComponent(identity.line)}`, lang, providerId),
				},
			);
		if (state === 'unconfirmed' && !liveMatch) return unavailable();
		const canonical = canonicalDepartureHref(event.url, identity);
		if (canonical) redirect(308, canonical);
	}
	// Record answers ready by the first byte are drawn on the server, so the head and cards are in
	// the first paint instead of growing under the reader.
	return readyAnswers(
		{
			identity,
			seoTitle: identity
				? lang === 'fr'
					? `Ligne ${line}, départ de ${time}`
					: `Line ${line}, ${time} departure`
				: lang === 'fr'
					? 'Départ'
					: 'Departure',
			lineMissing:
				identity !== null &&
				schedule != null &&
				!schedule.routes.some(({ id }) => id === identity.line),
			lang,
			city: providerId,
			period,
			day,
			mode,
			headsigns: directionHeadsigns(
				identity ? schedule?.route_directions?.[identity.line] : undefined,
			),
			stopNames: Object.fromEntries(
				(schedule?.stops ?? [])
					.filter((stop) => identity && stop.routes?.includes(identity.line))
					.map((stop) => [stop.id, stop.name]),
			),
			stopCodes: Object.fromEntries(
				(schedule?.stops ?? []).flatMap((stop) => (stop.code ? [[stop.id, stop.code]] : [])),
			),
			sections:
				identity && mode === 'record' && period
					? loadDepartureRecord({ ...scope, ...period }, identity, day)
					: [],
			liveTrips:
				mode === 'live' && v1 && onlyTrip
					? streamed(Promise.resolve({ trips: [], selected: onlyTrip }))
					: identity && mode === 'live' && v1
						? streamed(
								loadDepartureLive({ ...scope, from: today, to: today }, identity).then(
									async (trips) => {
										const selected =
											!requestedTrip || trips.includes(requestedTrip)
												? requestedTrip
												: await publishedDepartureTrip(
														providerId,
														requestedTrip,
														identity,
														visitorIp,
													);
										return { trips, selected };
									},
								),
							)
						: null,
		},
		READY_WAIT_MS,
		// The departure asks an unreachable answer again from the browser: it stays a promise.
		(value) => (value as { kind?: unknown } | null)?.kind === 'unreachable',
	);
};
