import { loadVehiclePage } from '#lib/server/vehicleRecord.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, url, request }) => {
	const { providerId } = await parent();
	return loadVehiclePage(url, request, providerId, new Date());
};
