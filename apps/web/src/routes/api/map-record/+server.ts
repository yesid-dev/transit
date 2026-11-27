import { json, type RequestHandler } from '@sveltejs/kit';
import { mapRecordAnswer } from '#lib/features/map/recordMapAnswer.ts';
import { mapRecordQuestion } from '#lib/server/engineQuestion.ts';
import { query } from '#lib/server/engine.ts';
import { frameClock, periodError } from '#lib/site/frameState.ts';

export const GET: RequestHandler = async ({ url, request }) => {
	const city = url.searchParams.get('city') ?? '';
	const from = url.searchParams.get('from') ?? '';
	const to = url.searchParams.get('to') ?? '';
	const layer = url.searchParams.get('layer');
	if (
		!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city) ||
		periodError({ from, to }, frameClock({ timezone: 'America/Toronto' }).today) ||
		['city', 'from', 'to', 'line', 'direction', 'layer'].some(
			(key) => url.searchParams.getAll(key).length > 1,
		) ||
		(layer !== null && layer !== 'corridors')
	) {
		return json({ state: 'invalid_period' }, { status: 400 });
	}
	const line = url.searchParams.get('line') ?? undefined;
	const direction = url.searchParams.get('direction') ?? undefined;
	const corridors = layer === 'corridors';
	const network = corridors && line === undefined;
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
		mapRecordQuestion({ city, from, to }, line, direction, corridors ? 'corridors' : undefined),
		mapRecordAnswer,
		request.headers.get('cf-connecting-ip'),
	);
	if (result.kind === 'unreachable') {
		if (network && result.reason) return json({ state: 'choose_line' }, { status: 409 });
		if (result.status === 400) return json({ state: 'invalid_request' }, { status: 400 });
	}
	if (
		result.kind !== 'answer' ||
		result.answer.measure !== (line || network ? 'mean_time_lost' : 'late') ||
		(result.answer.measure === 'mean_time_lost' &&
			network !== (result.answer.direction === undefined))
	) {
		return json({ state: 'unavailable' }, { status: 503 });
	}
	return json(
		{ ...result.answer, stale: result.lastGood ?? false },
		{
			headers: { 'cache-control': 'no-store' },
		},
	);
};
