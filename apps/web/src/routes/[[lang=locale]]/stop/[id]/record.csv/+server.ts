import { invalidRecordCsv, missingRecordCsv, recordCsvResponse } from '#lib/server/recordCsv.ts';
import { stopIdentity, validEntityId } from '#lib/server/entityIdentity.ts';
import { getScheduleEdition } from '#lib/server/engine.ts';
import { frameClock } from '#lib/site/frameState.ts';
import { stopRecordQueries, stopRecordQuery, type StopSection } from '#lib/server/stopRecord.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) => {
	const lang = params.lang === 'fr' ? 'fr' : 'en';
	// The same identity check as the stop page: an unknown stop gets no file of zeros.
	if (!validEntityId(params.id)) return missingRecordCsv(lang, 'STOP_NOT_FOUND');
	const section = url.searchParams.get('section') ?? '';
	if (section !== 'delay' && !Object.hasOwn(stopRecordQueries, section))
		return invalidRecordCsv(lang);
	return recordCsvResponse(
		stopRecordQuery(section as StopSection, params.id),
		url,
		request,
		lang,
		`stop-${params.id}-${section}.csv`,
		{
			identity: {
				code: 'STOP_NOT_FOUND',
				check: async (provider, scope) =>
					stopIdentity(
						params.id,
						frameClock(provider),
						scope,
						await getScheduleEdition(scope.city, scope.visitorIp, request.signal),
					),
			},
		},
	);
};
