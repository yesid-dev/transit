import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { toSlimStop } from '#lib/v1/repositories/stopsSlim.ts';
import { getCityCatalog, getScheduleEdition } from '#lib/server/engine.ts';

export const prerender = false;

export const GET: RequestHandler = async ({ url, request }) => {
	const visitorIp = request.headers.get('cf-connecting-ip');
	try {
		const requested = url.searchParams.getAll('provider');
		if (
			requested.length > 1 ||
			(requested[0] && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(requested[0]))
		) {
			return json({ error: 'invalid_city' }, { status: 400 });
		}
		const city = requested[0] || (await getCityCatalog(visitorIp)).default_provider;
		const edition = await getScheduleEdition(city, visitorIp);
		if (!edition) return json({ error: 'stops_index_unavailable' }, { status: 503 });
		return json(
			{
				generated_utc: `${edition.date}T00:00:00Z`,
				stops: edition.stops.map(toSlimStop),
			},
			{
				headers: {
					'cache-control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
				},
			},
		);
	} catch {
		return json({ error: 'stops_index_unavailable' }, { status: 503 });
	}
};
