import { loadLinesRecord } from '#lib/server/finderRecord.ts';
import type { PageServerLoad } from './$types';

export const load = (async ({ parent, url, request }) => {
	const { providerId } = await parent();
	return { finderRecord: loadLinesRecord(url, providerId, request) };
}) satisfies PageServerLoad;
