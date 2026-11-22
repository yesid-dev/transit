import { rankingsCsv } from '#lib/server/rankingsRecord.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, url, request }) =>
	rankingsCsv('/hotspots', url, request, params.lang === 'fr' ? 'fr' : 'en');
