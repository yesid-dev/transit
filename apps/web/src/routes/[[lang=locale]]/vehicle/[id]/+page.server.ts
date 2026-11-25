import { loadVehiclePage } from '#lib/server/vehicleRecord.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, url, request, params }) => {
	const { providerId, provider } = await parent();
	return loadVehiclePage(
		url,
		request,
		providerId,
		new Date(),
		params.id,
		provider?.timezone,
		provider?.record_through,
	);
};
