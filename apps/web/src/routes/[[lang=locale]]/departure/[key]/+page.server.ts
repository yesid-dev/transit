import { directionHeadsigns } from '#lib/features/lines/directions.ts';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { departureFromKey } from '#lib/features/record/departureIdentity.ts';
import {
	departureDay,
	loadDepartureLive,
	loadDepartureRecord,
	publishedDepartureTrip,
} from '#lib/server/departureDailyRecord.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';

export const load: PageServerLoad = async (event) => {
	const { providerId, lang, v1, schedule, provider } = await event.parent();
	const identity = departureFromKey(event.params.key);
	if (!identity)
		error(
			404,
			lang === 'fr'
				? 'Ce départ ne figure pas à l’horaire.'
				: 'This departure is not in the timetable.',
		);
	const today = frameToday(provider?.timezone);
	const { period, mode } = parseFrameState(event.url.searchParams, today);
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	const day = period ? departureDay(event.url.searchParams, period) : today;
	const scope = { city: providerId, visitorIp };
	const requestedTrip = event.url.searchParams.get('trip');
	return {
		identity,
		lineMissing: schedule != null && !schedule.routes.some(({ id }) => id === identity.line),
		lang,
		city: providerId,
		period,
		day,
		mode,
		headsigns: directionHeadsigns(schedule?.route_directions?.[identity.line]),
		stopNames: Object.fromEntries(
			(schedule?.stops ?? [])
				.filter((stop) => stop.routes?.includes(identity.line))
				.map((stop) => [stop.id, stop.name]),
		),
		stopCodes: Object.fromEntries(
			(schedule?.stops ?? []).flatMap((stop) => (stop.code ? [[stop.id, stop.code]] : [])),
		),
		sections:
			mode === 'record' && period
				? loadDepartureRecord({ ...scope, ...period }, identity, day)
				: [],
		liveTrips:
			mode === 'live' && v1
				? loadDepartureLive({ ...scope, from: today, to: today }, identity).then(async (trips) => {
						const selected =
							!requestedTrip || trips.includes(requestedTrip)
								? requestedTrip
								: await publishedDepartureTrip(providerId, requestedTrip, identity, visitorIp);
						return { trips, selected };
					})
				: null,
	};
};
