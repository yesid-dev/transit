import { localizeHref, type Locale } from '#lib/i18n/index.ts';
import {
	rankingMeasures,
	rankingPath,
	rankingSelection,
	type LegacyRankingPath,
	type RankingSelection,
} from './rankingUrls.ts';

export {
	rankingPath,
	rankingLists,
	rankingPathForKind,
	rankingKinds,
	isRankingPath,
	measures,
	reporting,
	rankingMeasures,
	worseIsHigher,
	canRankVehicles,
	rankingSelection,
} from './rankingUrls.ts';
export type {
	RankingKind,
	LegacyRankingPath,
	RankingPath,
	RankingMeasure,
	RankingSelection,
} from './rankingUrls.ts';

export function rankingHref(selection: RankingSelection, locale: Locale, source: URLSearchParams) {
	const params = new URLSearchParams(source);
	params.delete('kind');
	params.delete('measure');
	params.delete('class');
	if (selection.kind !== 'line') params.set('kind', selection.kind);
	if (selection.measure !== rankingMeasures[selection.kind][0])
		params.set('measure', selection.measure);
	if (selection.serviceClass) params.set('class', selection.serviceClass);
	return localizeHref(rankingPath + (params.size ? `?${params}` : ''), locale);
}

export function legacyRankingHref(path: LegacyRankingPath, url: URL, locale: Locale) {
	return rankingHref(rankingSelection(path, url.searchParams), locale, url.searchParams);
}
