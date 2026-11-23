import { loadStopsRecord } from '#lib/server/finderRecord.ts';
import type { PageServerLoad } from './$types';

export const load = (async ({ parent, url, request }) => {
	const { providerId, provider } = await parent();
	return { finderRecord: loadStopsRecord(url, providerId, request, provider?.timezone) };
}) satisfies PageServerLoad;
