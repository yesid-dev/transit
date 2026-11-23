import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { departureFromKey } from '#lib/features/record/departureIdentity.ts';
import {
	departureDay,
	loadDepartureLive,
	loadDepartureRecord,
} from '#lib/server/departureDailyRecord.ts';
import { getRoute } from '#lib/v1/repositories/static.ts';
import { serverV1Context } from '#lib/v1/serverContext.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';

export const load: PageServerLoad = async (event) => {
	const identity = departureFromKey(event.params.key);
	if (!identity) error(404);
	const today = frameToday();
	const { period, mode } = parseFrameState(event.url.searchParams, today);
	const { providerId, lang, v1 } = await event.parent();
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	const day = period ? departureDay(event.url.searchParams, period) : today;
	const metadata = v1
		? getRoute(identity.line, {
				...serverV1Context(event),
				providerId,
				manifest: v1.manifest,
			}).catch(() => null)
		: Promise.resolve(null);
	const scope = { city: providerId, visitorIp };
	return {
		identity,
		lang,
		city: providerId,
		period,
		day,
		mode,
		metadata,
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
