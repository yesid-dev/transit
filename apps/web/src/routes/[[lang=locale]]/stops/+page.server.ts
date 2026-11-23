import { loadStopsRecord } from '#lib/server/finderRecord.ts';
import type { PageServerLoad } from './$types';

export const load = (async ({ parent, url, request }) => {
	const { providerId } = await parent();
	return { finderRecord: loadStopsRecord(url, providerId, request) };
}) satisfies PageServerLoad;
