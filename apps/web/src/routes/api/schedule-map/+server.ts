import { json, type RequestHandler } from '@sveltejs/kit';
import { getScheduleMap } from '#lib/server/engine.ts';
import { readScheduleLineIds } from '#lib/server/scheduleLineIds.ts';

export const GET: RequestHandler = async ({ url, request }) => {
	const city = url.searchParams.get('city') ?? '';
	const raw = url.searchParams.get('lines') ?? '';
	const lines = url.search.length <= 4096 ? readScheduleLineIds(raw) : null;
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city) || url.searchParams.size !== 2 || !lines) {
		return json({ message: 'Invalid city or lines' }, { status: 400 });
	}
	if (new URLSearchParams({ city, lines: JSON.stringify(lines) }).toString().length > 4096) {
		return json({ message: 'Invalid city or lines' }, { status: 400 });
	}
	const schedule = await getScheduleMap(city, lines, request.headers.get('cf-connecting-ip'));
	if (!schedule) return json({ message: 'Schedule map unavailable' }, { status: 503 });
	return json({ schedule }, { headers: { 'cache-control': 'public, max-age=300' } });
};
