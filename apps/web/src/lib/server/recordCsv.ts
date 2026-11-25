import { error } from '@sveltejs/kit';
import { frameDateLimit, frameToday, periodError } from '#lib/site/frameState.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';
import { getCityCatalog, getRecordCsv, type RecordQuery } from './engine.ts';

export async function recordCsvResponse(
	query: RecordQuery,
	url: URL,
	request: Request,
	lang: 'en' | 'fr',
	filename: string,
	selectPeriod?: (period: DateWindow) => DateWindow,
) {
	const search = url.searchParams;
	const city = search.get('provider') ?? '';
	const period = { from: search.get('recordFrom') ?? '', to: search.get('recordTo') ?? '' };
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(city)) error(400);
	const visitorIp = request.headers.get('cf-connecting-ip');
	const catalog = await getCityCatalog(visitorIp).catch(() => error(503));
	const provider = catalog.providers.find(({ id }) => id === city);
	if (
		!provider ||
		periodError(period, frameDateLimit(frameToday(provider.timezone), provider.record_through))
	)
		error(400);
	const upstream = await getRecordCsv(
		query,
		{ ...(selectPeriod?.(period) ?? period), city, visitorIp },
		lang,
	).catch(() => null);
	const retryAfter = upstream?.headers.get('retry-after');
	if (upstream?.status === 503 && retryAfter) {
		return new Response(null, { status: 503, headers: { 'retry-after': retryAfter } });
	}
	if (!upstream?.ok || !upstream.headers.get('content-type')?.startsWith('text/csv')) error(503);
	const headers = new Headers({
		'content-type': 'text/csv; charset=utf-8',
		'content-disposition': `attachment; filename="${filename}"`,
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	});
	if (upstream.headers.get('x-transit-answer') === 'last-good')
		headers.set('x-transit-answer', 'last-good');
	return new Response(upstream.body, { headers });
}
