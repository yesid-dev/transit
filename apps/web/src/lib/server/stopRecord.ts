import { getRecordAnswer, type EnginePeriod, type RecordQuery } from './engine.ts';
import { alertDetailsAllowed } from '#lib/features/alerts/alertDetailsAllowed.ts';

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

export function loadStopRecord(scope: EnginePeriod, stop: string) {
	const { from, to, city } = scope;
	// The engine already computes both delay percentiles alongside the three bands.
	const punctuality = getRecordAnswer(stopRecordQuery('punctuality', stop), scope);
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
	return {
		period: { from, to },
		city,
		sections: sections.map((section) => ({
			section,
			answer:
				section === 'punctuality' || section === 'delay'
					? punctuality
					: getRecordAnswer(section === 'alerts' ? alerts : stopRecordQuery(section, stop), scope),
		})),
		// Keep the existing export queries and stream the display cuts independently.
		grid: getRecordAnswer(
			{ path: '/measure', parameters: { measure: 'late', group: 'weekday_hour', stop } },
			scope,
		),
		network: getRecordAnswer({ path: '/measure', parameters: { measure: 'on_time' } }, scope),
		networkDaily: getRecordAnswer(
			{ path: '/measure', parameters: { measure: 'on_time', group: 'day' } },
			scope,
		),
	};
}
