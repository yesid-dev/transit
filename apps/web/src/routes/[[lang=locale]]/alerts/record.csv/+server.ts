import { error } from '@sveltejs/kit';
import { alertDetailsAllowed } from '#lib/features/alerts/alertRecord.ts';
import { alertQuery } from '#lib/server/alertRecord.ts';
import { recordCsvResponse } from '#lib/server/recordCsv.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) => {
	const section = url.searchParams.get('section') ?? '';
	const query = alertQuery(section);
	if (!query) error(400);
	if (
		section === 'messages' &&
		!alertDetailsAllowed({
			from: url.searchParams.get('recordFrom') ?? '',
			to: url.searchParams.get('recordTo') ?? '',
		})
	)
		error(400);
	return recordCsvResponse(
		query,
		url,
		request,
		params.lang === 'fr' ? 'fr' : 'en',
		`alerts-${section}.csv`,
	);
};
