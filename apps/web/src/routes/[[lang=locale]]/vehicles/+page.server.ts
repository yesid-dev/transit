import { frameClock } from '#lib/site/frameState.ts';
import { loadVehiclePage } from '#lib/server/vehicleRecord.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, url, request }) => {
	const { providerId, provider, lang } = await parent();
	return {
		...loadVehiclePage(url, request, providerId, frameClock(provider)),
		seoTitle: lang === 'fr' ? 'Véhicules' : 'Vehicles',
	};
};
