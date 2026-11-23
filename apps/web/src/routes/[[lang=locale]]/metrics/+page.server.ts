import type { PageServerLoad } from './$types';
import { getMethodCatalog } from '#lib/server/engine.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';

export const load: PageServerLoad = ({ url, request }) => ({
	period: parseFrameState(url.searchParams, frameToday()).period,
	catalog: getMethodCatalog(request.headers.get('cf-connecting-ip')),
});
