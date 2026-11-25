import { directionHeadsigns } from '#lib/features/lines/directions.ts';
import type { PublicCity } from '#lib/v1/schemas/providers.ts';
import type { RouteFile } from '#lib/v1/index.ts';
import { recordCsvResponse } from './recordCsv.ts';
import { getRankingsRecord } from './engine.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import { rankingSelection, type RankingPath } from '#lib/features/rankings/rankingSelection.ts';
import type { Locale } from '#lib/i18n/index.ts';

import { rankingsQuery } from './screenQuestions.ts';
export { rankingsQuery } from './screenQuestions.ts';

export async function loadRankingsRecord(
	path: RankingPath,
	event: {
		url: URL;
		request: Request;
		parent: () => Promise<{
			providerId: string;
			provider?: Pick<PublicCity, 'timezone' | 'record_through'> | null;
			schedule?: { route_directions?: Record<string, RouteFile['directions']> } | null;
		}>;
	},
) {
	const { url, request, parent } = event;
	const selection = rankingSelection(path, url.searchParams);
	const { providerId: city, provider, schedule } = await parent();
	const { period } = parseAnswerFrameState(url.searchParams, frameClock(provider));
	return {
		selection,
		period,
		city,
		headsigns:
			selection.kind === 'departure'
				? Object.fromEntries(
						Object.entries(schedule?.route_directions ?? {}).map(([id, directions]) => [
							id,
							directionHeadsigns(directions),
						]),
					)
				: {},
		answer:
			period &&
			getRankingsRecord(rankingsQuery(selection).parameters, {
				...period,
				city,
				visitorIp: request.headers.get('cf-connecting-ip'),
			}),
	};
}

export function rankingsCsv(path: RankingPath, url: URL, request: Request, locale: Locale) {
	const selection = rankingSelection(path, url.searchParams);
	return recordCsvResponse(
		rankingsQuery(selection),
		url,
		request,
		locale,
		`rankings-${selection.kind}.csv`,
	);
}
