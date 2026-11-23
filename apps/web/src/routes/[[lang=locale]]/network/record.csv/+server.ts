import { error } from '@sveltejs/kit';
import { networkMeasures, type NetworkMeasure } from '#lib/features/network/networkRecordText.ts';
import { networkRecordQuery } from '#lib/server/networkRecord.ts';
import { recordCsvResponse } from '#lib/server/recordCsv.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) => {
	const section = url.searchParams.get('section') ?? '';
	if (!Object.hasOwn(networkMeasures, section)) error(400);
	return recordCsvResponse(
		networkRecordQuery(section as NetworkMeasure),
		url,
		request,
		params.lang === 'fr' ? 'fr' : 'en',
		`network-${section.replaceAll('_', '-')}.csv`,
	);
};
