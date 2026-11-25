import type { PageServerLoad } from './$types';
import { getMethodCatalog } from '#lib/server/engine.ts';
import { frameClock, parseFrameState } from '#lib/site/frameState.ts';

export const load: PageServerLoad = async ({ url, request, parent }) => {
	const { provider } = await parent();
	return {
		period: parseFrameState(url.searchParams, frameClock(provider)).period,
		catalog: getMethodCatalog(request.headers.get('cf-connecting-ip')),
	};
};
