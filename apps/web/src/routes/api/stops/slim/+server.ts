import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { toSlimStop } from '#lib/v1/repositories/stopsSlim.ts';
import { getCityCatalog, getScheduleEdition } from '#lib/server/engine.ts';
import { loadStopsRecord } from '#lib/server/finderRecord.ts';
import { frameClock } from '#lib/site/frameState.ts';
import { finderCells } from '#lib/features/record/finderText.ts';
import { stopReading, type NearbyStop } from '#lib/features/stops/stopListing.ts';
import { projectStops, stopSearchResult } from '#lib/server/stopListing.ts';

export const prerender = false;

export const GET: RequestHandler = async ({ url, request }) => {
	const visitorIp = request.headers.get('cf-connecting-ip');
	try {
		const requested = url.searchParams.getAll('provider');
		if (
			requested.length > 1 ||
			(requested[0] && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(requested[0]))
		) {
			return json({ error: 'invalid_city' }, { status: 400 });
		}
		if (url.searchParams.get('details') === 'search') {
			const catalog = await getCityCatalog(visitorIp);
			const city = requested[0] || catalog.default_provider;
			const provider = catalog.providers.find(({ id }) => id === city);
			if (!provider) return json({ error: 'invalid_city' }, { status: 400 });
			const scope = request.headers.get('x-transit-fixture-scope') ?? undefined;
			const edition = await getScheduleEdition(city, visitorIp, scope, request.signal);
			if (!edition) return json({ error: 'stops_index_unavailable' }, { status: 503 });
			const locale = url.searchParams.get('lang') === 'fr' ? 'fr' : 'en';
			return json(
				await stopSearchResult(projectStops(edition, url, request, city, provider, locale)),
				{
					headers: { 'cache-control': 'no-store' },
				},
			);
		}
		const city = requested[0] || (await getCityCatalog(visitorIp)).default_provider;
		const edition = await getScheduleEdition(city, visitorIp);
		if (!edition) return json({ error: 'stops_index_unavailable' }, { status: 503 });
		if (url.searchParams.get('details') === 'record') {
			// Nearby ordering runs in the browser. This edition is shared by every visitor.
			const record = loadStopsRecord(url, city, request, frameClock(null));
			const cells = finderCells((await record?.punctuality) ?? null, 'stop');
			const codes = new Map(edition.routes.map(({ id, short }) => [id, short]));
			const stops = edition.stops.map((stop): NearbyStop => {
				const routeIds = stop.routes ?? [];
				const cell = cells.get(stop.id);
				return {
					...toSlimStop(stop),
					routeIds,
					lineCodes: routeIds.map((id) => codes.get(id) ?? id),
					...(cell ? { reading: stopReading(cell) } : {}),
				};
			});
			return json({ generated_utc: `${edition.date}T00:00:00Z`, stops });
		}
		return json(
			{
				generated_utc: `${edition.date}T00:00:00Z`,
				stops: edition.stops.map(toSlimStop),
			},
			{
				headers: {
					'cache-control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
				},
			},
		);
	} catch {
		return json({ error: 'stops_index_unavailable' }, { status: 503 });
	}
};
