import { recordCsvResponse } from './recordCsv.ts';
import { getRankingsRecord, type RecordQuery } from './engine.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import {
	rankingSelection,
	type RankingPath,
	type RankingSelection,
} from '#lib/features/rankings/rankingSelection.ts';
import type { Locale } from '#lib/i18n/index.ts';

export function rankingsQuery({ kind, measure, serviceClass }: RankingSelection): RecordQuery {
	return {
		path: '/ranking',
		parameters: { kind, measure, ...(serviceClass ? { class: serviceClass } : {}), limit: '500' },
	};
}

export async function loadRankingsRecord(
	path: RankingPath,
	event: {
		url: URL;
		request: Request;
		parent: () => Promise<{ providerId: string }>;
	},
) {
	const { url, request, parent } = event;
	const selection = rankingSelection(path, url.searchParams);
	const { period } = parseFrameState(url.searchParams, frameToday());
	const { providerId: city } = await parent();
	return {
		selection,
		period,
		city,
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
