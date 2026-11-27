import { error } from '@sveltejs/kit';
import { recordCsvResponse } from '#lib/server/recordCsv.ts';
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
	const section = url.searchParams.get('section') ?? '';
	if (!Object.hasOwn(sections, section)) error(400);
	return recordCsvResponse(
		sections[section as keyof typeof sections],
		url,
		request,
		params.lang === 'fr' ? 'fr' : 'en',
		`overview-${section}.csv`,
		section === 'previous' ? previousPeriod : undefined,
	);
};
