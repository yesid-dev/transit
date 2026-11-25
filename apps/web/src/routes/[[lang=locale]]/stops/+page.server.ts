import { frameClock } from '#lib/site/frameState.ts';
import { loadStopsRecord } from '#lib/server/finderRecord.ts';
import { getScheduleEdition } from '#lib/server/engine.ts';
import { listStops, stopListingTotals, stopListingView } from '#lib/features/stops/stopListing.ts';
import type { PageServerLoad } from './$types';

export const load = (async ({ parent, url, request, locals }) => {
	const { providerId, provider, lang } = await parent();
	const view = stopListingView(url.searchParams);
	const schedule =
		locals.stopsSchedule === undefined && provider
			? await getScheduleEdition(
					providerId,
					request.headers.get('cf-connecting-ip'),
					request.headers.get('x-transit-fixture-scope') ?? undefined,
				)
			: locals.stopsSchedule;
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
}) satisfies PageServerLoad;
