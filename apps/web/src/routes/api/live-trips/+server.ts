import { json, type RequestHandler } from '@sveltejs/kit';
import { getCaptureResponse } from '#lib/server/engine.ts';

const noStore = { 'cache-control': 'no-store' };

export const GET: RequestHandler = async ({ url, request }) => {
	const city = url.searchParams.get('city');
	const kind = (['line', 'stop', 'trip'] as const).find((key) => url.searchParams.has(key));
	const id = kind ? url.searchParams.get(kind) : null;
	if (
		url.searchParams.size !== 2 ||
		!city ||
		!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city) ||
		!kind ||
		!id ||
		id.length > 256 ||
		id !== id.trim() ||
		/[^\S ]|\p{C}/u.test(id)
	) {
		return json({ state: 'invalid_scope' }, { status: 400, headers: noStore });
	}
	try {
		const response = await getCaptureResponse(
			city,
			request.signal,
			request.headers.get('cf-connecting-ip'),
			{ kind, id },
		);
		if (response?.ok || response?.status === 404 || response?.status === 503) {
			const headers = new Headers({ ...noStore, 'content-type': 'application/json' });
			const retryAfter = response.headers.get('retry-after');
			if (retryAfter) headers.set('retry-after', retryAfter);
			return new Response(response.body, { status: response.status, headers });
		}
	} catch {
		// The next Live refresh can recover from an expired or unavailable proxy connection.
	}
	return json({ state: 'unavailable' }, { status: 503, headers: noStore });
};
