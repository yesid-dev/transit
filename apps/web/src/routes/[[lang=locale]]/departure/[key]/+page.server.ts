import { directionHeadsigns } from '#lib/features/lines/directions.ts';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { departureFromKey } from '#lib/features/record/departureIdentity.ts';
import {
	departureDay,
	loadDepartureLive,
	loadDepartureRecord,
} from '#lib/server/departureDailyRecord.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';

export const load: PageServerLoad = async (event) => {
	const identity = departureFromKey(event.params.key);
	if (!identity) error(404);
	const { providerId, lang, v1, schedule, provider } = await event.parent();
	const today = frameToday(provider?.timezone);
	const { period, mode } = parseFrameState(event.url.searchParams, today);
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	const day = period ? departureDay(event.url.searchParams, period) : today;
	const scope = { city: providerId, visitorIp };
	return {
		identity,
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
		sections:
			mode === 'record' && period
				? loadDepartureRecord({ ...scope, ...period }, identity, day)
				: [],
		liveTrips:
			mode === 'live' && v1
				? loadDepartureLive({ ...scope, from: today, to: today }, identity)
				: null,
	};
};
