import { frameClock } from '#lib/site/frameState.ts';
import { loadVehiclePage } from '#lib/server/vehicleRecord.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, url, request, params }) => {
	const { providerId, provider, lang } = await parent();
	return {
		...loadVehiclePage(url, request, providerId, frameClock(provider), params.id),
		seoTitle: lang === 'fr' ? `Véhicule ${params.id}` : `Vehicle ${params.id}`,
	};
};
