import { error } from '@sveltejs/kit';
import { recordCsvResponse } from '#lib/server/recordCsv.ts';
import { stopRecordQueries, stopRecordQuery, type StopSection } from '#lib/server/stopRecord.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) => {
	const section = url.searchParams.get('section') ?? '';
	if (section !== 'delay' && !Object.hasOwn(stopRecordQueries, section)) error(400);
	return recordCsvResponse(
		stopRecordQuery(section as StopSection, params.id.trim() || params.id),
		url,
		request,
		params.lang === 'fr' ? 'fr' : 'en',
		`stop-${section}.csv`,
	);
};
