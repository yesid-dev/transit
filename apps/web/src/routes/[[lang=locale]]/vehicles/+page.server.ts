import { frameClock } from '#lib/site/frameState.ts';
import { loadVehiclePage } from '#lib/server/vehicleRecord.ts';
import { fleetView, projectFleetAnswer } from '#lib/features/vehicles/vehicleFleet.ts';
import type { PageServerLoad } from './$types';
import { readyAnswers } from '#lib/server/readyAnswers.ts';

export const load: PageServerLoad = async ({ parent, url, request }) => {
	const { providerId, provider, lang } = await parent();
	const view = fleetView(url.searchParams);
	const { mode, period, city, sections } = loadVehiclePage(
		url,
		request,
		providerId,
		frameClock(provider),
	);
	return readyAnswers({
		mode,
		period,
		city,
		view,
		fleet: sections[0]?.answer.then((answer) => projectFleetAnswer(answer, view, lang)),
		seoTitle: lang === 'fr' ? 'Véhicules' : 'Vehicles',
	});
};
