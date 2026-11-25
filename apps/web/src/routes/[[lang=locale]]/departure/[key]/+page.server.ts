import { directionHeadsigns } from '#lib/features/lines/directions.ts';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { departureFromKey, isDepartureTripId } from '#lib/features/record/departureIdentity.ts';
import {
	departureDay,
	loadDepartureLive,
	loadDepartureRecord,
	publishedDepartureTrip,
} from '#lib/server/departureDailyRecord.ts';
import { scheduledClock } from '#lib/site/presenter.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';

export const load: PageServerLoad = async (event) => {
	const { providerId, lang, v1, schedule, provider } = await event.parent();
	const identity = departureFromKey(event.params.key);
	const requestedTrip = event.url.searchParams.get('trip');
	const onlyTrip =
		event.params.key === 'trip' && isDepartureTripId(requestedTrip) ? requestedTrip : null;
	if (!identity && !onlyTrip)
		error(
			404,
			lang === 'fr'
				? 'Ce départ ne figure pas à l’horaire.'
				: 'This departure is not in the timetable.',
		);
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
	return {
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
				? Promise.resolve({ trips: [], selected: onlyTrip })
				: identity && mode === 'live' && v1
					? loadDepartureLive({ ...scope, from: today, to: today }, identity).then(
							async (trips) => {
								const selected =
									!requestedTrip || trips.includes(requestedTrip)
										? requestedTrip
										: await publishedDepartureTrip(providerId, requestedTrip, identity, visitorIp);
								return { trips, selected };
							},
						)
					: null,
	};
};
