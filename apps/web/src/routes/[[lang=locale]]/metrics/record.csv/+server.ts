import { invalidRecordCsv, recordCsvResponse } from '#lib/server/recordCsv.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) => {
	const lang = params.lang === 'fr' ? 'fr' : 'en';
	const measure = url.searchParams.get('section') ?? '';
	if (!/^[a-z][a-z0-9_]*$/.test(measure)) return invalidRecordCsv(lang);
	return recordCsvResponse(
		{ path: '/measure', parameters: { measure } },
		url,
		request,
		lang,
		`measure-${measure}.csv`,
	);
};
