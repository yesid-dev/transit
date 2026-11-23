import { error } from '@sveltejs/kit';
import { departureFromKey } from '#lib/features/record/departureIdentity.ts';
import { departureDay, departureQuery } from '#lib/server/departureDailyRecord.ts';
import { recordCsvResponse } from '#lib/server/recordCsv.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) => {
	const identity = departureFromKey(params.key);
	if (!identity) error(404);
	const section = url.searchParams.get('section') ?? '';
	const query = departureQuery(section, identity);
	if (!query) error(400);
	return recordCsvResponse(
		query,
		url,
		request,
		params.lang === 'fr' ? 'fr' : 'en',
		`departure-${section}.csv`,
		section === 'stops'
			? (period) => {
					const day = departureDay(url.searchParams, period);
					return { from: day, to: day };
				}
			: undefined,
	);
};
