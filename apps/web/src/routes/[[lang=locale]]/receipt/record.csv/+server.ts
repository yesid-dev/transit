import { alertDetailsAllowed } from '#lib/features/alerts/alertRecord.ts';
import { dailyQuery } from '#lib/server/departureDailyRecord.ts';
import { invalidRecordCsv, recordCsvResponse } from '#lib/server/recordCsv.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) => {
	const lang = params.lang === 'fr' ? 'fr' : 'en';
	const section = url.searchParams.get('section') ?? '';
	const query = dailyQuery(section);
	if (!query) return invalidRecordCsv(lang);
	if (section === 'messages') {
		const from = url.searchParams.get('recordFrom') ?? '';
		const to = url.searchParams.get('recordTo') ?? '';
		if (!alertDetailsAllowed({ from, to })) return invalidRecordCsv(lang, 'dates');
	}
	return recordCsvResponse(query, url, request, lang, `daily-${section}.csv`);
};
