import { json } from '@sveltejs/kit';
import { liveSummary } from '#lib/features/home/liveSummary.ts';
import { captureSnapshotSchema } from '#lib/live/captureSnapshot.ts';
import { getCaptureResponse } from '#lib/server/engine.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

const noStore = { 'cache-control': 'no-store' };

/**
 * The Overview's Live now card in a few hundred bytes: the same live capture as /api/live, read
 * through the same projections, without the vehicle positions and alert texts the card never shows.
 */
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
			const snapshot = captureSnapshotSchema.parse(await live.json());
			if (snapshot.city === city) {
				return json(liveSummary(snapshot, Date.now()), { headers: noStore });
			}
		} else if (live?.status === 404) {
			return json({ state: 'no_live_data' }, { status: 404, headers: noStore });
		}
	} catch {
		// The card falls back to the full capture; the next refresh can recover.
	}
	return json({ state: 'unavailable' }, { status: 503, headers: noStore });
};
