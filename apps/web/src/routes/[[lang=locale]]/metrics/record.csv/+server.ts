import { error } from '@sveltejs/kit';
import { recordCsvResponse } from '#lib/server/recordCsv.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) => {
	const measure = url.searchParams.get('section') ?? '';
	if (!/^[a-z][a-z0-9_]*$/.test(measure)) error(400);
	return recordCsvResponse(
		{ path: '/measure', parameters: { measure } },
		url,
		request,
		params.lang === 'fr' ? 'fr' : 'en',
		`${measure}.csv`,
	);
};
