import { error } from '@sveltejs/kit';
import { departureFromKey } from '#lib/features/record/departureIdentity.ts';
import { departureDay, departureQuery } from '#lib/server/departureDailyRecord.ts';
import { recordCsvResponse } from '#lib/server/recordCsv.ts';
import { frameToday, periodError } from '#lib/site/frameState.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) => {
	const identity = departureFromKey(params.key);
	if (!identity) error(404);
	const section = url.searchParams.get('section') ?? '';
	const query = departureQuery(section, identity);
	if (!query) error(400);
	const target = new URL(url);
	if (section === 'stops') {
		const { searchParams } = target;
		const period = {
			from: searchParams.get('recordFrom') ?? '',
			to: searchParams.get('recordTo') ?? '',
		};
		if (periodError(period, frameToday())) error(400);
		const day = departureDay(searchParams, period);
		searchParams.set('recordFrom', day);
		searchParams.set('recordTo', day);
	}
	return recordCsvResponse(
		query,
		target,
		request,
		params.lang === 'fr' ? 'fr' : 'en',
		`departure-${section}.csv`,
	);
};
