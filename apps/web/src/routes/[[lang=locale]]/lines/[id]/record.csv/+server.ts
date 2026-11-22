import { error } from '@sveltejs/kit';
import { recordCsvResponse } from '#lib/server/recordCsv.ts';
import {
	lineDirection,
	lineRecordQueries,
	lineRecordQuery,
	type LineSection,
} from '#lib/server/lineRecord.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, request }) => {
	const search = url.searchParams;
	const section = search.get('section') ?? '';
	if (!Object.hasOwn(lineRecordQueries, section)) error(400);
	return recordCsvResponse(
		lineRecordQuery(section as LineSection, params.id.trim() || params.id, lineDirection(search)),
		url,
		request,
		params.lang === 'fr' ? 'fr' : 'en',
		`line-${section}.csv`,
	);
};
