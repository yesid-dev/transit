import { directionHeadsigns } from '#lib/features/lines/directions.ts';
import type { PublicCity } from '#lib/v1/schemas/providers.ts';
import type { RouteFile } from '#lib/v1/index.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import { recordCsvResponse } from './recordCsv.ts';
import { getRankingsRecord, getRecordAnswer, type RankingsRecord } from './engine.ts';
import { frameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import {
	canRankVehicles,
	rankingSelection,
	type RankingKind,
	type RankingPath,
} from '#lib/features/rankings/rankingSelection.ts';
import type { Locale } from '#lib/i18n/index.ts';

import { readingFilter } from './readingFilter.ts';
import { rankingsQuery } from './screenQuestions.ts';
export { rankingsQuery } from './screenQuestions.ts';

export type RankingIdentities = {
	stops: Record<string, Pick<ScheduleEdition['stops'][number], 'name' | 'code'>>;
	headsigns: Record<string, Record<number, string>>;
};

export function rankingHeadsigns(directions: RouteFile['directions'] | undefined) {
	const published = directionHeadsigns(directions);
	for (const { dir, headsign } of directions ?? []) {
		const sign = headsign?.trim();
		if (dir != null && sign && published[dir] !== sign) delete published[dir];
	}
	return published;
}

function rankingIdentities(
	kind: RankingKind,
	schedule: ScheduleEdition | null | undefined,
	data: RankingsRecord,
): RankingIdentities {
	const rows = [...data.rows, ...data.excluded];
	const stops = new Set(kind === 'stop' ? rows.map(({ id }) => id) : []);
	const lines = new Set(
		kind === 'line'
			? rows.map(({ id }) => id)
			: kind === 'departure'
				? rows.flatMap(({ line }) => (line ? [line] : []))
				: [],
	);
	return {
		stops: Object.fromEntries(
			(schedule?.stops ?? [])
				.filter(({ id }) => stops.has(id))
				.map(({ id, name, code }) => [id, { name, code }]),
		),
		headsigns: Object.fromEntries(
			[...lines].map((line) => [line, rankingHeadsigns(schedule?.route_directions?.[line])]),
		),
	};
}

export async function loadRankingsRecord(
	path: RankingPath,
	event: {
		url: URL;
		request: Request;
		locals?: Pick<App.Locals, 'rankingsSchedule'>;
		parent: () => Promise<{
			providerId: string;
			provider?:
				| (Pick<PublicCity, 'timezone' | 'record_through'> & Partial<Pick<PublicCity, 'inputs'>>)
				| null;
		}>;
	},
	only?: ReadonlySet<string>,
) {
	const { url, request, parent, locals } = event;
	const include = readingFilter(only);
	const selection = rankingSelection(path, url.searchParams);
	const { providerId: city, provider } = await parent();
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
		answer:
			scope && include('answer')
				? getRankingsRecord(rankingsQuery(selection).parameters, scope).then((result) =>
						result.kind === 'answer'
							? {
									...result,
									identities: rankingIdentities(
										selection.kind,
										locals?.rankingsSchedule,
										result.answer,
									),
								}
							: result,
					)
				: null,
		reference:
			scope && include('reference')
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
