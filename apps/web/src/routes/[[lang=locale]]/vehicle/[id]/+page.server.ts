import { frameClock } from '#lib/site/frameState.ts';
import { loadVehiclePage } from '#lib/server/vehicleRecord.ts';
import { validEntityId, vehicleIdentity } from '#lib/server/entityIdentity.ts';
import { fetchCaptureSnapshot } from '#lib/live/captureSnapshot.ts';
import { detailNotFoundCopy } from '#lib/site/errorPage.ts';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, url, request, params, fetch }) => {
	const { id } = params;
	const locale = params.lang === 'fr' ? 'fr' : 'en';
	function missingVehicle(): never {
		error(404, detailNotFoundCopy.VEHICLE_NOT_FOUND[locale].heading, { code: 'VEHICLE_NOT_FOUND' });
	}
	if (!validEntityId(id)) missingVehicle();
	const { providerId, provider, lang } = await parent();
	const clock = frameClock(provider);
	const identity = await vehicleIdentity(
		id,
		clock,
		{ city: providerId, visitorIp: request.headers.get('cf-connecting-ip') },
		provider?.inputs.vehicle_positions,
		() => fetchCaptureSnapshot(providerId, request.signal, fetch),
		request.signal,
	);
	if (identity === 'missing') missingVehicle();
	if (identity === 'unconfirmed')
		error(
			503,
			lang === 'fr'
				? 'Ce véhicule est temporairement indisponible.'
				: 'This vehicle is temporarily unavailable.',
		);
	return {
		...loadVehiclePage(url, request, providerId, clock, id),
		seoTitle: lang === 'fr' ? `Véhicule ${id}` : `Vehicle ${id}`,
	};
};
