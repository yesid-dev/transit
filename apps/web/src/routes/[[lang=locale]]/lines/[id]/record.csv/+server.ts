import { error } from '@sveltejs/kit';
import { missingRecordCsv, recordCsvResponse } from '#lib/server/recordCsv.ts';
import { lineIdentity, validEntityId } from '#lib/server/entityIdentity.ts';
import { getScheduleEdition } from '#lib/server/engine.ts';
import { frameClock } from '#lib/site/frameState.ts';
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
	const lang = params.lang === 'fr' ? 'fr' : 'en';
	if (!validEntityId(params.id)) return missingRecordCsv(lang, 'LINE_NOT_FOUND');
	if (!Object.hasOwn(lineRecordQueries, section)) error(400);
	return recordCsvResponse(
		lineRecordQuery(section as LineSection, params.id, lineDirection(search)),
		url,
		request,
		lang,
		`line-${section}.csv`,
		{
			identity: {
				code: 'LINE_NOT_FOUND',
				check: async (provider, scope) =>
					lineIdentity(
						params.id,
						frameClock(provider),
						scope,
						await getScheduleEdition(scope.city, scope.visitorIp, request.signal),
					),
			},
		},
	);
};
