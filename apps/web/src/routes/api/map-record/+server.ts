import { json, type RequestHandler } from '@sveltejs/kit';
import { mapRecordAnswer } from '#lib/features/map/recordMapAnswer.ts';
import { mapRecordQuestion } from '#lib/server/engineQuestion.ts';
import { query } from '#lib/server/engine.ts';

export const GET: RequestHandler = async ({ url, request }) => {
	const city = url.searchParams.get('city') ?? '';
	const from = url.searchParams.get('from') ?? '';
	const to = url.searchParams.get('to') ?? '';
	if (
		!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city) ||
		!/^\d{4}-\d{2}-\d{2}$/.test(from) ||
		!/^\d{4}-\d{2}-\d{2}$/.test(to)
	) {
		return json({ state: 'invalid_period' }, { status: 400 });
	}
	const line = url.searchParams.get('line') ?? undefined;
	const direction = url.searchParams.get('direction') ?? undefined;
	if (
		line !== undefined &&
		(!line || line.length > 256 || line !== line.trim() || /[^\S ]|\p{C}/u.test(line))
	) {
		return json({ state: 'invalid_line' }, { status: 400 });
	}
	if (direction !== undefined && (!line || !['0', '1'].includes(direction))) {
		return json({ state: 'invalid_direction' }, { status: 400 });
	}
	const result = await query(
		mapRecordQuestion({ city, from, to }, line, direction),
		mapRecordAnswer,
		request.headers.get('cf-connecting-ip'),
	);
	if (result.kind !== 'answer' || result.answer.measure !== (line ? 'mean_time_lost' : 'late')) {
		return json({ state: 'unavailable' }, { status: 503 });
	}
	return json(
		{ ...result.answer, stale: result.lastGood ?? false },
		{
			headers: { 'cache-control': 'no-store' },
		},
	);
};
