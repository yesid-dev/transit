import { networkMeasures, type NetworkMeasure } from '#lib/features/network/networkRecordText.ts';
import { getScorecardAnswer, type EnginePeriod, type RecordQuery } from './engine.ts';

export function networkRecordQuery(measure: NetworkMeasure): RecordQuery {
	return { path: '/measure', parameters: { measure } };
}

export function loadNetworkRecord(scope: EnginePeriod) {
	const { from, to, city } = scope;
	return {
		period: { from, to },
		city,
		sections: (Object.keys(networkMeasures) as NetworkMeasure[]).map((measure) => ({
			measure,
			answer: getScorecardAnswer(networkRecordQuery(measure), scope),
		})),
	};
}
