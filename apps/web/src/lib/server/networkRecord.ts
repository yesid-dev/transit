import {
	getDelayDistribution,
	getRecordAnswer,
	type EnginePeriod,
	type RecordQuery,
} from './engine.ts';
import { readingFilter, type Complete } from './readingFilter.ts';
import { networkRecordQuestions } from './screenQuestions.ts';

export const networkServiceQueries = {
	bands: networkRecordQuestions.punctuality,
	delay: { measure: 'delay_distribution' },
	trend: networkRecordQuestions.trend,
	delivery: networkRecordQuestions.deliveryDays,
	hours: networkRecordQuestions.hours,
	crowding: networkRecordQuestions.crowding,
} satisfies Record<string, RecordQuery['parameters']>;

function readNetworkRecord(scope: EnginePeriod, only?: ReadonlySet<string>) {
	const { from, to, city } = scope;
	const include = readingFilter(only);
	const measure = (name: string, parameters: RecordQuery['parameters']) =>
		include(name) ? getRecordAnswer({ path: '/measure', parameters }, scope) : undefined;
	return {
		period: { from, to },
		city,
		punctuality: measure('punctuality', networkServiceQueries.bands),
		delayDistribution: include('delayDistribution') ? getDelayDistribution(scope) : undefined,
		dayTypes: measure('dayTypes', networkRecordQuestions.dayTypes),
		trend: measure('trend', networkServiceQueries.trend),
		delivery: measure('delivery', networkRecordQuestions.delivery),
		deliveryDays: measure('deliveryDays', networkServiceQueries.delivery),
		hours: measure('hours', networkServiceQueries.hours),
		crowding: measure('crowding', networkServiceQueries.crowding),
	};
}

type NetworkRecord = Complete<ReturnType<typeof readNetworkRecord>>;

/** Network health's readings; with `only`, just the named readings, asked again. */
export function loadNetworkRecord(
	scope: EnginePeriod,
	only: ReadonlySet<string>,
): Partial<NetworkRecord>;
// Last, so `ReturnType` names the whole record.
export function loadNetworkRecord(scope: EnginePeriod): NetworkRecord;
export function loadNetworkRecord(scope: EnginePeriod, only?: ReadonlySet<string>) {
	return readNetworkRecord(scope, only);
}
