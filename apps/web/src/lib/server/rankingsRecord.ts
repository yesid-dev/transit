import { directionHeadsigns } from '#lib/features/lines/directions.ts';
import type { PublicCity } from '#lib/v1/schemas/providers.ts';
import type { RouteFile } from '#lib/v1/index.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import { recordCsvResponse } from './recordCsv.ts';
import { getRankingsRecord, getRecordAnswer } from './engine.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import {
	canRankVehicles,
	rankingSelection,
	type RankingPath,
} from '#lib/features/rankings/rankingSelection.ts';
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
			provider?:
				| (Pick<PublicCity, 'timezone' | 'record_through'> & Partial<Pick<PublicCity, 'inputs'>>)
				| null;
			schedule?: {
				route_directions?: Record<string, RouteFile['directions']>;
				stops?: ScheduleEdition['stops'];
			} | null;
		}>;
	},
) {
	const { url, request, parent } = event;
	const selection = rankingSelection(path, url.searchParams);
	const { providerId: city, provider, schedule } = await parent();
	const { period } = parseAnswerFrameState(url.searchParams, frameClock(provider));
	const notTracked = selection.kind === 'vehicle' && !canRankVehicles(provider?.inputs);
	const scope = period &&
		!notTracked && {
			...period,
			city,
			visitorIp: request.headers.get('cf-connecting-ip'),
		};
	return {
		selection,
		period,
		city,
		notTracked,
		stops: selection.kind === 'stop' ? (schedule?.stops ?? []) : [],
		headsigns:
			selection.kind === 'departure'
				? Object.fromEntries(
						Object.entries(schedule?.route_directions ?? {}).map(([id, directions]) => [
							id,
							directionHeadsigns(directions),
						]),
					)
				: {},
		answer: scope ? getRankingsRecord(rankingsQuery(selection).parameters, scope) : null,
		reference: scope
			? getRecordAnswer({ path: '/measure', parameters: { measure: selection.measure } }, scope)
			: null,
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
