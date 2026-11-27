import { alertDetailsAllowed } from '#lib/features/alerts/alertRecord.ts';
import { alertQuery } from '#lib/server/alertRecord.ts';
import { invalidRecordCsv, recordCsvResponse } from '#lib/server/recordCsv.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) => {
	const lang = params.lang === 'fr' ? 'fr' : 'en';
	const section = url.searchParams.get('section') ?? '';
	const query = alertQuery(section);
	if (!query) return invalidRecordCsv(lang);
	if (
		section === 'messages' &&
		!alertDetailsAllowed({
			from: url.searchParams.get('recordFrom') ?? '',
			to: url.searchParams.get('recordTo') ?? '',
		})
	)
		return invalidRecordCsv(lang, 'dates');
	return recordCsvResponse(query, url, request, lang, `alerts-${section}.csv`);
};
