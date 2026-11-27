import { frameClock } from '#lib/site/frameState.ts';
import { loadVehiclePage } from '#lib/server/vehicleRecord.ts';
import { archivedIdentity, validEntityId } from '#lib/server/entityIdentity.ts';
import {
	captureDisplayState,
	captureFamily,
	fetchCaptureSnapshot,
} from '#lib/live/captureSnapshot.ts';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, url, request, params, fetch }) => {
	const { id } = params;
	if (!validEntityId(id)) error(404);
	const { providerId, provider, lang } = await parent();
	const clock = frameClock(provider);
	const identity = await archivedIdentity('vehicle', id, clock, {
		city: providerId,
		visitorIp: request.headers.get('cf-connecting-ip'),
	});
	if (identity !== 'available') {
		const tracked = provider?.inputs.vehicle_positions;
		const live = tracked
			? await fetchCaptureSnapshot(providerId, request.signal, fetch).catch(() => null)
			: null;
		const current =
			live &&
			captureDisplayState(
				captureFamily(live, 'vehicle_positions'),
				Date.now(),
				live.published_at,
			) === 'live';
		const positions = current ? live.vehicle_positions : undefined;
		if (!positions?.some((row) => (row.vehicle_id ?? row.id) === id)) {
			if (identity === 'missing' && (tracked === false || positions))
				error(
					404,
					lang === 'fr' ? 'Ce véhicule est introuvable.' : 'This vehicle could not be found.',
				);
			error(
				503,
				lang === 'fr'
					? 'Ce véhicule est temporairement indisponible.'
					: 'This vehicle is temporarily unavailable.',
			);
		}
	}
	return {
		...loadVehiclePage(url, request, providerId, clock, id),
		seoTitle: lang === 'fr' ? `Véhicule ${id}` : `Vehicle ${id}`,
	};
};
