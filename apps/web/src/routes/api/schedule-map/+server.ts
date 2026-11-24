import { json, type RequestHandler } from '@sveltejs/kit';
import { getScheduleMap } from '#lib/server/engine.ts';

export const GET: RequestHandler = async ({ url, request }) => {
	const city = url.searchParams.get('city') ?? '';
	const raw = url.searchParams.get('lines') ?? '';
	let ids: unknown;
	try {
		if (url.search.length <= 4096) ids = JSON.parse(raw);
	} catch {
		// Malformed input is handled by the same validation as other invalid cuts.
	}
	if (
		!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city) ||
		url.searchParams.size !== 2 ||
		!Array.isArray(ids) ||
		ids.length < 1 ||
		ids.length > 256 ||
		!ids.every(
			(id): id is string =>
				typeof id === 'string' &&
				id.length > 0 &&
				[...id].length <= 256 &&
				id === id.trim() &&
				!/[\p{C}\p{Z}]/u.test(id.replaceAll(' ', '')),
		)
	) {
		return json({ message: 'Invalid city or lines' }, { status: 400 });
	}
	const lines = [...new Set(ids)].sort();
	if (new URLSearchParams({ city, lines: JSON.stringify(lines) }).toString().length > 4096) {
		return json({ message: 'Invalid city or lines' }, { status: 400 });
	}
	const schedule = await getScheduleMap(city, lines, request.headers.get('cf-connecting-ip'));
	if (!schedule) return json({ message: 'Schedule map unavailable' }, { status: 503 });
	return json({ schedule }, { headers: { 'cache-control': 'public, max-age=300' } });
};
