import type { Locale } from '#lib/i18n/index.ts';
import type { PublicCity } from '#lib/v1/schemas/providers.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import { frameClock } from '#lib/site/frameState.ts';
import { listStops, stopListingTotals, stopListingView } from '#lib/features/stops/stopListing.ts';
import { loadStopsRecord } from './finderRecord.ts';

/** Both document loads and interactive searches return the same stop and reading projection. */
export function projectStops(
	schedule: ScheduleEdition | null | undefined,
	url: URL,
	request: Request,
	providerId: string,
	provider: PublicCity | null,
	lang: Locale,
) {
	const view = stopListingView(url.searchParams);
	const listing = schedule ? listStops(schedule, url.searchParams, lang) : null;
	const record = loadStopsRecord(url, providerId, request, frameClock(provider));
	const ids = new Set(listing?.rows.map(({ id }) => id));
	const archivedCode =
		view.query && !view.route && listing?.total === 0 && /^[\p{L}\p{N}_-]+$/u.test(view.query)
			? view.query
			: null;
	return {
		listing,
		view,
		finderRecord: record && {
			...record,
			punctuality: record.punctuality.then((result) => {
				if (result.kind !== 'answer') return result;
				const cells = result.answer.cells.filter(
					({ key }) =>
						typeof key.stop === 'string' && (ids.has(key.stop) || key.stop === archivedCode),
				);
				return {
					...result,
					answer: { ...result.answer, cells },
					totals: stopListingTotals(result.answer.cells),
				};
			}),
		},
	};
}

export async function stopSearchResult(projected: ReturnType<typeof projectStops>) {
	const { finderRecord } = projected;
	return {
		...projected,
		finderRecord: finderRecord && { ...finderRecord, punctuality: await finderRecord.punctuality },
	};
}

export type StopSearchResult = Awaited<ReturnType<typeof stopSearchResult>>;
