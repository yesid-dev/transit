import { networkMeasures, type NetworkMeasure } from '#lib/features/network/networkRecordText.ts';
import { networkServiceQueries } from '#lib/server/networkRecord.ts';
import { healthDiagnosticQuery } from '#lib/server/screenQuestions.ts';
import { invalidRecordCsv, recordCsvResponse } from '#lib/server/recordCsv.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) => {
	const lang = params.lang === 'fr' ? 'fr' : 'en';
	const section = url.searchParams.get('section') ?? '';
	const query = Object.hasOwn(networkMeasures, section)
		? healthDiagnosticQuery(section as NetworkMeasure)
		: Object.hasOwn(networkServiceQueries, section)
			? {
					path: '/measure' as const,
					parameters: networkServiceQueries[section as keyof typeof networkServiceQueries],
				}
			: null;
	if (!query) return invalidRecordCsv(lang);
	return recordCsvResponse(
		query,
		url,
		request,
		lang,
		`network-${section.replaceAll('_', '-')}.csv`,
	);
};
