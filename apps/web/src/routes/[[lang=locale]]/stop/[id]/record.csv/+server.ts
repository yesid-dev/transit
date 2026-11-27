import { invalidRecordCsv, recordCsvResponse } from '#lib/server/recordCsv.ts';
import { stopRecordQueries, stopRecordQuery, type StopSection } from '#lib/server/stopRecord.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) => {
	const lang = params.lang === 'fr' ? 'fr' : 'en';
	const section = url.searchParams.get('section') ?? '';
	if (section !== 'delay' && !Object.hasOwn(stopRecordQueries, section))
		return invalidRecordCsv(lang);
	return recordCsvResponse(
		stopRecordQuery(section as StopSection, params.id.trim() || params.id),
		url,
		request,
		lang,
		`stop-${section}.csv`,
	);
};
