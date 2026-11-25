import { rankingLists, rankingPath } from '#lib/features/rankings/rankingSelection.ts';
import { loadRankingsRecord } from '#lib/server/rankingsRecord.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const record = await loadRankingsRecord(rankingPath, event);
	const locale = event.params.lang === 'fr' ? 'fr' : 'en';
	return { record, seoTitle: rankingLists[record.selection.kind].title[locale] };
};
