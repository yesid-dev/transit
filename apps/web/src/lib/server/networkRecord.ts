import {
	getDelayDistribution,
	getRecordAnswer,
	type EnginePeriod,
	type RecordQuery,
} from './engine.ts';
import { networkRecordQuestions } from './screenQuestions.ts';

export const networkServiceQueries = {
	bands: networkRecordQuestions.punctuality,
	delay: { measure: 'delay_distribution' },
	trend: networkRecordQuestions.trend,
	delivery: networkRecordQuestions.deliveryDays,
	hours: networkRecordQuestions.hours,
	crowding: networkRecordQuestions.crowding,
} satisfies Record<string, RecordQuery['parameters']>;

export function loadNetworkRecord(scope: EnginePeriod) {
	const { from, to, city } = scope;
	const measure = (parameters: RecordQuery['parameters']) =>
		getRecordAnswer({ path: '/measure', parameters }, scope);
	return {
		period: { from, to },
		city,
		punctuality: measure(networkServiceQueries.bands),
		delayDistribution: getDelayDistribution(scope),
		dayTypes: measure(networkRecordQuestions.dayTypes),
		trend: measure(networkServiceQueries.trend),
		delivery: measure(networkRecordQuestions.delivery),
		deliveryDays: measure(networkServiceQueries.delivery),
		hours: measure(networkServiceQueries.hours),
		crowding: measure(networkServiceQueries.crowding),
	};
}
