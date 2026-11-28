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

const compassWord = /^(est|ouest|nord|sud|east|west|north|south)\b/iu;

/**
 * A ranked departure names its destination only when its direction has one. When a direction's
 * trips carry several destinations ("Est", "Est destination Station Snowdon"), the compass word
 * they all share still tells the way ("toward the east"); with nothing shared, none is named.
 */
export function rankingHeadsigns(directions: RouteFile['directions'] | undefined) {
	const published = directionHeadsigns(directions);
	const signs = new Map<number, Set<string>>();
	for (const { dir, headsign } of directions ?? []) {
		const sign = headsign?.trim();
		if (dir != null && sign) signs.set(dir, (signs.get(dir) ?? new Set()).add(sign));
	}
	for (const [dir, all] of signs) {
		if (all.size < 2) continue;
		const words = new Set([...all].map((sign) => compassWord.exec(sign)?.[1]));
		const [word] = words;
		if (words.size === 1 && word) published[dir] = word;
		else delete published[dir];
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
	const ranking =
		scope && include('answer')
			? getRankingsRecord(rankingsQuery(selection).parameters, scope)
			: null;
	const readReference =
		scope && include('reference')
			? () =>
					getRecordAnswer({ path: '/measure', parameters: { measure: selection.measure } }, scope)
			: null;
	return {
		selection,
		period,
		city,
		notTracked,
		answer:
			ranking?.then((result) => {
				if (result.kind !== 'answer') return result;
				const { reference: _, ...answer } = result.answer;
				return {
					...result,
					answer,
					identities: rankingIdentities(selection.kind, locals?.rankingsSchedule, answer),
				};
			}) ?? null,
		reference:
			ranking && selection.kind === 'vehicle' && readReference
				? ranking.then((result) => {
						if (result.kind !== 'answer') return result;
						return result.answer.reference
							? { ...result, answer: result.answer.reference }
							: readReference();
					})
				: (readReference?.() ?? null),
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
