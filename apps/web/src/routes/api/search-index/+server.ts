import { json, type RequestHandler } from '@sveltejs/kit';
import { getSearchIndex } from '#lib/server/engine.ts';

export const GET: RequestHandler = async ({ url, request }) => {
	const city = url.searchParams.get('city') ?? '';
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city) || url.searchParams.size !== 1) {
		return json({ message: 'Invalid city' }, { status: 400 });
	}
	const result = await getSearchIndex(city, request.headers.get('cf-connecting-ip'));
	return result.kind === 'answer' && !result.lastGood
		? json(result.answer, { headers: { 'cache-control': 'no-store' } })
		: json({ message: 'Search index unavailable' }, { status: 503 });
};
