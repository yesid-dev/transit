import { json, type RequestHandler } from '@sveltejs/kit';
import { getScheduleEdition } from '#lib/server/engine.ts';

export const GET: RequestHandler = async ({ url, request }) => {
	const city = url.searchParams.get('city') ?? '';
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city) || url.searchParams.size !== 1) {
		return json({ message: 'Invalid city' }, { status: 400 });
	}
	const visitorIp = request.headers.get('cf-connecting-ip');
	const edition = await getScheduleEdition(city, visitorIp);
	if (!edition) return json({ message: 'Schedule unavailable' }, { status: 503 });
	return json(
		{ schedule: edition },
		{
			headers: { 'cache-control': 'public, max-age=300' },
		},
	);
};
