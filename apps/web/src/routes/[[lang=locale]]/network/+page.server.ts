import type { PageServerLoad } from './$types';
import { getNetworkTrend, getHistoricAvailability } from '#lib/v1/repositories/historic.ts';
import { adapter } from '#lib/v1/adapter/index.ts';
import type { LiveReader } from '#lib/v1/live/store.svelte.ts';
import { getProvenance } from '#lib/v1/repositories/provenance.ts';
import { serverV1Context } from '#lib/v1/serverContext.ts';
import { loadNetworkRecord } from '#lib/server/networkRecord.ts';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import { networkRecordView } from '#lib/site/networkFrame.ts';

export const load: PageServerLoad = async (event) => {
	if (!networkRecordView(event.url))
		return { view: 'live' as const, ...(await _loadWithReader(event, adapter.live)) };

	const { providerId: city } = await event.parent();
	const { period } = parseFrameState(event.url.searchParams, frameToday());
	const visitorIp = event.request.headers.get('cf-connecting-ip');
	return {
		view: 'record' as const,
		networkRecord: period && loadNetworkRecord({ ...period, city, visitorIp }),
	};
};

export async function _loadWithReader(
	event: Parameters<PageServerLoad>[0],
	reader: Pick<LiveReader, 'network'>,
) {
	const { v1 } = await event.parent();
	if (!v1)
		return {
			networkSeed: null,
			trendSeed: null,
			provenanceSeed: null,
			historicAvailabilitySeed: null,
		};
	const context = {
		...serverV1Context(event),
		providerId: v1.manifest.provider,
		manifest: v1.manifest,
	};
	const [networkResult, trendResult, provenanceResult, availabilityResult] =
		await Promise.allSettled([
			reader.network(context),
			getNetworkTrend(context),
			getProvenance(context),
			getHistoricAvailability(context),
		]);

	return {
		historicAvailabilitySeed:
			availabilityResult.status === 'fulfilled' && availabilityResult.value
				? { key: 'historic-availability', data: availabilityResult.value }
				: null,
		networkSeed: networkResult.status === 'fulfilled' ? networkResult.value : null,
		trendSeed:
			trendResult.status === 'fulfilled' ? { key: 'network-trend', data: trendResult.value } : null,
		provenanceSeed:
			provenanceResult.status === 'fulfilled'
				? { key: 'provenance', data: provenanceResult.value }
				: null,
	};
}
