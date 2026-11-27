import { json, type RequestHandler } from '@sveltejs/kit';
import { getScheduleEdition, getSearchIndex } from '#lib/server/engine.ts';
import { linePatterns } from '#lib/site/linePatterns.ts';

export const GET: RequestHandler = async ({ url, request }) => {
	const city = url.searchParams.get('city') ?? '';
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city) || url.searchParams.size !== 1) {
		return json({ message: 'Invalid city' }, { status: 400 });
	}
	const visitorIp = request.headers.get('cf-connecting-ip');
	const [result, edition] = await Promise.all([
		getSearchIndex(city, visitorIp),
		getScheduleEdition(city, visitorIp),
	]);
	return result.kind === 'answer'
		? json(
				{
					...result.answer,
					patterns:
						!result.lastGood && edition && edition.date === result.answer.schedule?.date
							? linePatterns(edition)
							: undefined,
				},
				{ headers: { 'cache-control': 'private, max-age=300' } },
			)
		: json({ message: 'Search index unavailable' }, { status: 503 });
};
