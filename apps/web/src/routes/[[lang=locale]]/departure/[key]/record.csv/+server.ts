import {
	canonicalDepartureHref,
	departureFromKey,
} from '#lib/features/record/departureIdentity.ts';
import {
	departureDay,
	departureQuery,
	identifyDeparture,
} from '#lib/server/departureDailyRecord.ts';
import { invalidRecordCsv, missingRecordCsv, recordCsvResponse } from '#lib/server/recordCsv.ts';
import { validEntityId } from '#lib/server/entityIdentity.ts';
import { frameClock } from '#lib/site/frameState.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) => {
	const identity = departureFromKey(params.key);
	const lang = params.lang === 'fr' ? 'fr' : 'en';
	if (!identity || !validEntityId(identity.line))
		return missingRecordCsv(lang, 'DEPARTURE_NOT_FOUND');
	const section = url.searchParams.get('section') ?? '';
	const query = departureQuery(section, identity);
	if (!query) return invalidRecordCsv(lang);
	return recordCsvResponse(query, url, request, lang, `departure-${section}.csv`, {
		identity: {
			code: 'DEPARTURE_NOT_FOUND',
			check: (provider, scope) => identifyDeparture(identity, frameClock(provider), scope),
			canonicalHref: canonicalDepartureHref(url, identity),
		},
		selectPeriod:
			section === 'stops'
				? (period) => {
						const day = departureDay(url.searchParams, period);
						return { from: day, to: day };
					}
				: undefined,
	});
};
