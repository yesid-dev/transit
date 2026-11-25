import { error, redirect } from '@sveltejs/kit';
import {
	captureSnapshotSchema,
	captureTripScopeSchema,
	feedState,
} from '#lib/live/captureSnapshot.ts';
import { fixAgeS, isVehicleStale, STALE_CUTOFF_S } from '#lib/components/map/vehicleProjection.ts';
import { departureHref } from '#lib/features/record/departureIdentity.ts';
import { vehicleLiveHref } from '#lib/features/vehicles/vehicleLinks.ts';
import { query } from '#lib/server/engine.ts';
import { cityQuestion } from '#lib/server/engineQuestion.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, parent, url, request, setHeaders }) => {
	const id = params.id;
	if (!id || id.length > 256 || id !== id.trim() || /[^\S ]|\p{C}/u.test(id)) error(404);
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
		query(tripQuestion, captureTripScopeSchema, ip),
	]);
	if (positions?.kind === 'answer' && positions.answer.city === city && !positions.lastGood) {
		const now = Date.now();
		const feed = Object.values(positions.answer.feeds).find(
			(entry) => entry.family === 'vehicle_positions',
		);
		const captured = feed?.captured_at;
		if (captured && feedState(feed, now) === 'live') {
			const vehicle = positions.answer.vehicle_positions?.find(
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
	if (trips.kind === 'answer' && trips.answer.city === city) {
		const trip = trips.answer.trip_updates.find((row) => row.trip_id === id);
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
		error(404);
	}
	if (!provider.inputs.trip_updates && !provider.inputs.vehicle_positions) error(404);
	error(
		503,
		lang === 'fr'
			? 'Les données du trajet sont temporairement indisponibles.'
			: 'Trip data is temporarily unavailable.',
	);
};
