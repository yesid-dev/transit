import type { PageServerLoad } from './$types';
import { getDataHealth } from '#lib/v1/repositories/dataHealth.ts';
import { getHistoricAvailability } from '#lib/v1/repositories/historic.ts';
import { getProvenance } from '#lib/v1/repositories/provenance.ts';
import { serverV1Context } from '#lib/v1/serverContext.ts';
import { getMethodCatalog, getRecordDataHealth } from '#lib/server/engine.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';

export const load: PageServerLoad = async (event) => {
	const { v1, providerId: city, provider } = await event.parent();
	const { mode, period } = parseFrameState(event.url.searchParams, frameToday(provider?.timezone));
	if (mode === 'record') {
		const visitorIp = event.request.headers.get('cf-connecting-ip');
		return {
			view: 'record' as const,
			record: period && {
				city,
				period,
				health: getRecordDataHealth({ ...period, city, visitorIp }),
				methods: getMethodCatalog(visitorIp),
			},
		};
	}
	if (!v1)
		return {
			view: 'live' as const,
			provenanceSeed: null,
			dataHealthSeed: null,
			historicAvailabilitySeed: null,
		};
	const context = {
		...serverV1Context(event),
		providerId: v1.manifest.provider,
		manifest: v1.manifest,
	};
	const [provenanceResult, dataHealthResult, historicAvailabilityResult] = await Promise.allSettled(
		[getProvenance(context), getDataHealth(context), getHistoricAvailability(context)],
	);

	return {
		view: 'live' as const,
		provenanceSeed:
			provenanceResult.status === 'fulfilled'
				? { key: 'provenance', data: provenanceResult.value }
				: null,
		dataHealthSeed:
			dataHealthResult.status === 'fulfilled'
				? { key: 'data-health', data: dataHealthResult.value }
				: null,
		historicAvailabilitySeed:
			historicAvailabilityResult.status === 'fulfilled'
				? { key: 'historic-availability', data: historicAvailabilityResult.value }
				: null,
	};
};
