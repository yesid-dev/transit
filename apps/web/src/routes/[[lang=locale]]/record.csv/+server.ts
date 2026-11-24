import { error } from '@sveltejs/kit';
import { recordCsvResponse } from '#lib/server/recordCsv.ts';
import type { RecordQuery } from '#lib/server/engine.ts';
import { previousPeriod } from '#lib/features/home/periodComparison.ts';
import type { RequestHandler } from './$types';

const sections = {
	punctuality: { path: '/measure', parameters: { measure: 'punctuality' } },
	previous: { path: '/measure', parameters: { measure: 'on_time' } },
	delivery: { path: '/measure', parameters: { measure: 'trips_run' } },
	trend: { path: '/measure', parameters: { measure: 'on_time', group: 'day' } },
	lines: { path: '/ranking', parameters: { kind: 'line', measure: 'on_time', limit: '3' } },
	stops: { path: '/ranking', parameters: { kind: 'stop', measure: 'on_time', limit: '3' } },
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
