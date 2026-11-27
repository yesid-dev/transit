import { invalidRecordCsv, recordCsvResponse } from '#lib/server/recordCsv.ts';
import type { RecordQuery } from '#lib/server/engine.ts';
import { overviewRankingParameters } from '#lib/server/engineQuestion.ts';
import { overviewTrendQuery } from '#lib/server/screenQuestions.ts';
import { previousPeriod } from '#lib/features/home/periodComparison.ts';
import type { RequestHandler } from './$types';

const sections = {
	punctuality: { path: '/measure', parameters: { measure: 'punctuality' } },
	previous: { path: '/measure', parameters: { measure: 'on_time' } },
	delivery: { path: '/measure', parameters: { measure: 'trips_run' } },
	trend: overviewTrendQuery,
	lines: { path: '/ranking', parameters: overviewRankingParameters('line') },
	stops: { path: '/ranking', parameters: overviewRankingParameters('stop') },
} satisfies Record<string, RecordQuery>;

export const GET: RequestHandler = ({ url, request, params }) => {
	const lang = params.lang === 'fr' ? 'fr' : 'en';
	const section = url.searchParams.get('section') ?? '';
	if (!Object.hasOwn(sections, section)) return invalidRecordCsv(lang);
	return recordCsvResponse(
		sections[section as keyof typeof sections],
		url,
		request,
		lang,
		`overview-${section}.csv`,
		{ selectPeriod: section === 'previous' ? previousPeriod : undefined },
	);
};
