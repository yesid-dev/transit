import type { PageServerLoad } from './$types';
import { getMethodCatalog } from '#lib/server/engine.ts';
import { readyAnswers } from '#lib/server/readyAnswers.ts';
import { frameClock, parseFrameState } from '#lib/site/frameState.ts';

export const load: PageServerLoad = async ({ url, request, parent }) => {
	const { provider } = await parent();
	// A catalogue ready before the first byte is drawn on the server, like every Record answer:
	// the measures are in the first paint instead of waiting for the page's scripts.
	return readyAnswers({
		period: parseFrameState(url.searchParams, frameClock(provider)).period,
		catalog: getMethodCatalog(request.headers.get('cf-connecting-ip')),
	});
};
