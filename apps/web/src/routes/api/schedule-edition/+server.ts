import { json, type RequestHandler } from '@sveltejs/kit';
import { getScheduleEdition, getScheduleMap } from '#lib/server/engine.ts';

export const GET: RequestHandler = async ({ url, request }) => {
	const city = url.searchParams.get('city') ?? '';
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city) || url.searchParams.size !== 1) {
		return json({ message: 'Invalid city' }, { status: 400 });
	}
	const visitorIp = request.headers.get('cf-connecting-ip');
	const [edition, map] = await Promise.all([
		getScheduleEdition(city, visitorIp),
		getScheduleMap(city, visitorIp),
	]);
	if (!edition) return json({ message: 'Schedule unavailable' }, { status: 503 });
	const route_directions =
		map?.date === edition.date
			? { ...edition.route_directions, ...map.route_shapes }
			: edition.route_directions;
	return json(
		{ schedule: { ...edition, route_directions } },
		{
			headers: { 'cache-control': 'public, max-age=300' },
		},
	);
};
