import { error, redirect } from '@sveltejs/kit';
import {
	captureDisplayState,
	captureSnapshotSchema,
	captureTripScopeSchema,
} from '#lib/live/captureSnapshot.ts';
import { fixAgeS, isVehicleStale, STALE_CUTOFF_S } from '#lib/components/map/vehicleProjection.ts';
import { departureHref } from '#lib/features/record/departureIdentity.ts';
import { localizeHref } from '#lib/i18n/index.ts';
import { vehicleLiveHref } from '#lib/features/vehicles/vehicleLinks.ts';
import { query, type EngineResult } from '#lib/server/engine.ts';
import { cityQuestion } from '#lib/server/engineQuestion.ts';
import { validEntityId } from '#lib/server/entityIdentity.ts';
import type { PageServerLoad } from './$types';

function currentAnswer<T extends { city: string }>(result: EngineResult<T> | null, city: string) {
	return result?.kind === 'answer' &&
		result.answer.city === city &&
		!result.lastGood &&
		!result.cacheStale
		? result.answer
		: null;
}

export const load: PageServerLoad = async ({ params, parent, url, request, setHeaders }) => {
	const id = params.id;
	if (!validEntityId(id)) error(404);
	const { providerId: city, lang, provider, discoveryError } = await parent();
	if (discoveryError) error(503);
	if (!provider) error(404);
	setHeaders({ 'cache-control': 'no-store' });
	const ip = request.headers.get('cf-connecting-ip');
	const tripQuestion = cityQuestion(city, '/live-trips');
	tripQuestion.parameters.trip = id;
	const [positions, trips] = await Promise.all([
		provider.inputs.vehicle_positions
			? query(cityQuestion(city, '/live'), captureSnapshotSchema, ip)
			: null,
		provider.inputs.trip_updates ? query(tripQuestion, captureTripScopeSchema, ip) : null,
	]);
	const now = Date.now();
	const location = currentAnswer(positions, city);
	if (location) {
		const feed = Object.values(location.feeds).find(
			(entry) => entry.family === 'vehicle_positions',
		);
		const captured = feed?.captured_at;
		if (captured && captureDisplayState(feed, now, location.published_at) === 'live') {
			const vehicle = location.vehicle_positions?.find(
				(row) =>
					row.trip_id === id &&
					!isVehicleStale(
						fixAgeS(row.observed_at, captured, now),
						STALE_CUTOFF_S + feed.source_lag_seconds,
					),
			);
			if (vehicle)
				redirect(307, vehicleLiveHref(vehicle.vehicle_id ?? vehicle.id, url, lang, city));
		}
	}
	/** An ended trip names its line when any live row still carries it, even a stale one. */
	function ended(route: string | null | undefined): never {
		error(404, {
			code: 'TRIP_ENDED',
			message: lang === 'fr' ? 'Ce trajet ne circule plus.' : 'This trip is no longer running.',
			line: route ? localizeHref(`/lines/${encodeURIComponent(route)}`, lang, city) : undefined,
		});
	}
	const lastPosition =
		positions?.kind === 'answer' && positions.answer.city === city
			? positions.answer.vehicle_positions?.find((row) => row.trip_id === id && row.route_id)
			: undefined;
	const updates = currentAnswer(trips, city);
	if (
		updates?.feed.family === 'trip_updates' &&
		captureDisplayState(updates.feed, now) === 'live'
	) {
		const trip = updates.trip_updates.find((row) => row.trip_id === id);
		// GTFS-Realtime trip relationships CANCELED and DELETED.
		if (trip?.relationship === 3 || trip?.relationship === 7) ended(trip.route_id);
		if (trip?.route_id && trip.start_time) {
			const href = departureHref(
				url,
				lang,
				city,
				trip.route_id,
				trip.direction_id,
				trip.start_time,
				'live',
				id,
			);
			if (href) redirect(307, href);
		}
		// A trip seen earlier in the live positions ended; an ID never seen may be a typo.
		if (!trip && lastPosition) ended(lastPosition.route_id);
		if (!trip)
			error(404, {
				code: 'TRIP_UNAVAILABLE',
				message:
					lang === 'fr'
						? 'Ce trajet n’est pas accessible dans la vue En direct.'
						: 'This trip is unavailable in Live.',
			});
	}
	error(
		503,
		lang === 'fr'
			? 'Les données du trajet sont temporairement indisponibles.'
			: 'Trip data is temporarily unavailable.',
	);
};
