import { rankingPath } from '#lib/features/rankings/rankingSelection.ts';
import { rankingsCsv } from '#lib/server/rankingsRecord.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) =>
	rankingsCsv(rankingPath, url, request, params.lang === 'fr' ? 'fr' : 'en');
