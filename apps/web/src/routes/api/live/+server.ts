import { json } from '@sveltejs/kit';
import { getCaptureResponse } from '#lib/server/engine.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

const noStore = { 'cache-control': 'no-store' };

export const GET: RequestHandler = async ({ url, request }) => {
	const [city] = url.searchParams.getAll('city');
	if (url.searchParams.size !== 1 || !city || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city)) {
		return json({ state: 'invalid_city' }, { status: 400, headers: noStore });
	}

	try {
		const live = await getCaptureResponse(
			city,
			request.signal,
			request.headers.get('cf-connecting-ip'),
		);
		if (live?.ok) {
			return new Response(live.body, {
				headers: { ...noStore, 'content-type': 'application/json' },
			});
		}
		if (live?.status === 404) {
			return json({ state: 'no_live_data' }, { status: 404, headers: noStore });
		}
	} catch {
		// The next Live refresh can recover from an expired or unavailable proxy connection.
	}
	return json({ state: 'unavailable' }, { status: 503, headers: noStore });
};
