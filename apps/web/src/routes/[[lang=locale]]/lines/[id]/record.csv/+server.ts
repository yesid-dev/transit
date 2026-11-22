import { error } from '@sveltejs/kit';
import { getRecordCsv } from '#lib/server/engine.ts';
import {
	lineDirection,
	lineRecordQueries,
	lineRecordQuery,
	type LineSection,
} from '#lib/server/lineRecord.ts';
import { frameToday, periodError } from '#lib/site/frameState.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url }) => {
	const search = url.searchParams;
	const section = search.get('section') ?? '';
	const city = search.get('provider') ?? '';
	const period = { from: search.get('recordFrom') ?? '', to: search.get('recordTo') ?? '' };
	if (
		!Object.hasOwn(lineRecordQueries, section) ||
		!/^[a-z0-9][a-z0-9_-]*$/.test(city) ||
		periodError(period, frameToday())
	) {
		error(400);
	}
	const upstream = await getRecordCsv(
		lineRecordQuery(section as LineSection, params.id.trim() || params.id, lineDirection(search)),
		{ ...period, city },
		params.lang === 'fr' ? 'fr' : 'en',
	).catch(() => null);
	if (!upstream?.ok || !upstream.headers.get('content-type')?.startsWith('text/csv')) error(503);
	return new Response(upstream.body, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="line-${section}.csv"`,
			'x-content-type-options': 'nosniff',
		},
	});
};
