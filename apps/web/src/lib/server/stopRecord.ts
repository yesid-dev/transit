import { getRecordAnswer, type EnginePeriod, type RecordQuery } from './engine.ts';
import { alertDetailsAllowed } from '#lib/features/alerts/alertDetailsAllowed.ts';
import { readingFilter, type Complete } from './readingFilter.ts';

export const stopRecordQueries = {
	punctuality: { measure: 'punctuality' },
	byLine: { measure: 'on_time', group: 'line' },
	waiting: { measure: 'waiting_and_gaps', group: 'line' },
	hourly: { measure: 'on_time', group: 'hour' },
	daily: { measure: 'on_time', group: 'day' },
	alerts: { measure: 'alert_counts' },
	accessibility: { measure: 'accessible_stops' },
} as const;

export type StopSection = keyof typeof stopRecordQueries | 'delay';

export function stopRecordQuery(section: StopSection, stop: string): RecordQuery {
	return {
		path: '/measure',
		parameters: {
			...stopRecordQueries[section === 'delay' ? 'punctuality' : section],
			stop,
		},
	};
}

function readStopRecord(scope: EnginePeriod, stop: string, only?: ReadonlySet<string>) {
	const { from, to, city } = scope;
	const include = readingFilter(only);
	// The engine already computes both delay percentiles alongside the three bands.
	const punctuality =
		include('punctuality') || include('delay')
			? getRecordAnswer(stopRecordQuery('punctuality', stop), scope)
			: null;
	const alerts = stopRecordQuery('alerts', stop);
	if (alertDetailsAllowed(scope)) alerts.parameters.alert_details = '1';
	const sections: StopSection[] = [
		'punctuality',
		'byLine',
		'waiting',
		'hourly',
		'daily',
		'delay',
		'accessibility',
		'alerts',
	];
	const measure = (parameters: RecordQuery['parameters']) =>
		getRecordAnswer({ path: '/measure', parameters }, scope);
	return {
		period: { from, to },
		city,
		sections: sections.filter(include).map((section) => ({
			section,
			answer:
				(section === 'punctuality' || section === 'delay') && punctuality
					? punctuality
					: getRecordAnswer(section === 'alerts' ? alerts : stopRecordQuery(section, stop), scope),
		})),
		// Keep the existing export queries and stream the display cuts independently.
		grid: include('grid') ? measure({ measure: 'late', group: 'weekday_hour', stop }) : undefined,
		network: include('network') ? measure({ measure: 'on_time' }) : undefined,
		networkDaily: include('networkDaily')
			? measure({ measure: 'on_time', group: 'day' })
			: undefined,
	};
}

type StopRecord = Complete<ReturnType<typeof readStopRecord>>;

/** The stop's readings; with `only`, just the named readings, asked again. */
export function loadStopRecord(
	scope: EnginePeriod,
	stop: string,
	only: ReadonlySet<string>,
): Partial<StopRecord>;
// Last, so `ReturnType` names the whole record.
export function loadStopRecord(scope: EnginePeriod, stop: string): StopRecord;
export function loadStopRecord(scope: EnginePeriod, stop: string, only?: ReadonlySet<string>) {
	return readStopRecord(scope, stop, only);
}
