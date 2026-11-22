import { error } from '@sveltejs/kit';
import { dailyQuery } from '#lib/server/departureDailyRecord.ts';
import { recordCsvResponse } from '#lib/server/recordCsv.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) => {
	const section = url.searchParams.get('section') ?? '';
	const query = dailyQuery(section);
	if (!query) error(400);
	return recordCsvResponse(
		query,
		url,
		request,
		params.lang === 'fr' ? 'fr' : 'en',
		`daily-${section}.csv`,
	);
};
