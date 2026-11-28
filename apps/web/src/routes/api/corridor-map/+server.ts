import { json, type RequestHandler } from '@sveltejs/kit';
import { corridorMapAnswer } from '#lib/features/map/corridorMap.ts';
import { query } from '#lib/server/engine.ts';
import { cityQuestion } from '#lib/server/engineQuestion.ts';

export const GET: RequestHandler = async ({ url, request }) => {
	const city = url.searchParams.get('city') ?? '';
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city) || url.searchParams.size !== 1) {
		return json({ message: 'Invalid city' }, { status: 400 });
	}
	const result = await query(
		cityQuestion(city, '/corridor-map'),
		corridorMapAnswer,
		request.headers.get('cf-connecting-ip'),
	);
	if (result.kind !== 'answer' || !result.answer.schedule) {
		return json({ message: 'Corridor paths unavailable' }, { status: 503 });
	}
	return json(result.answer, { headers: { 'cache-control': 'public, max-age=300' } });
};
