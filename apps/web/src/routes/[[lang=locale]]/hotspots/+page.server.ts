import { loadRankingsRecord } from '#lib/server/rankingsRecord.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = (event) => loadRankingsRecord('/hotspots', event);
