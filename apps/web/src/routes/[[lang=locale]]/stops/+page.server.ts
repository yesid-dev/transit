import { getScheduleEdition } from '#lib/server/engine.ts';
import { projectStops } from '#lib/server/stopListing.ts';
import type { PageServerLoad } from './$types';

export const load = (async ({ parent, url, request, locals }) => {
	const { providerId, provider, lang } = await parent();
	const schedule =
		locals.stopsSchedule === undefined && provider
			? await getScheduleEdition(
					providerId,
					request.headers.get('cf-connecting-ip'),
					request.headers.get('x-transit-fixture-scope') ?? undefined,
				)
			: locals.stopsSchedule;
	return projectStops(schedule, url, request, providerId, provider, lang);
}) satisfies PageServerLoad;
