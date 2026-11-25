import { frameClock } from '#lib/site/frameState.ts';
import { loadLinesRecord } from '#lib/server/finderRecord.ts';
import type { PageServerLoad } from './$types';

export const load = (async ({ parent, url, request }) => {
	const { providerId, provider } = await parent();
	return {
		finderRecord: loadLinesRecord(url, providerId, request, frameClock(provider)),
	};
}) satisfies PageServerLoad;
