import { getRecordAnswer, type EnginePeriod, type RecordQuery } from './engine.ts';
import { alertDetailsAllowed } from '#lib/features/alerts/alertDetailsAllowed.ts';
import { readingFilter, type Complete } from './readingFilter.ts';
import type { EntityIdentity } from './entityIdentity.ts';

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

function readStopRecord(
	scope: EnginePeriod,
	stop: string,
	only?: ReadonlySet<string>,
	identity?: Promise<EntityIdentity>,
) {
	const { from, to, city } = scope;
	const include = readingFilter(only);
	const ask = (query: RecordQuery) =>
		identity
			? identity.then((state) =>
					state === 'available'
						? getRecordAnswer(query, scope)
						: ({ kind: 'unreachable' } as const),
				)
			: getRecordAnswer(query, scope);
	// The engine already computes both delay percentiles alongside the three bands.
	const punctuality =
		include('punctuality') || include('delay') ? ask(stopRecordQuery('punctuality', stop)) : null;
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
	const measure = (parameters: RecordQuery['parameters']) => ask({ path: '/measure', parameters });
	return {
		period: { from, to },
		city,
		delivery: include('delivery') ? measure({ measure: 'service_delivered', stop }) : undefined,
		sections: sections.filter(include).map((section) => ({
			section,
			answer:
				(section === 'punctuality' || section === 'delay') && punctuality
					? punctuality
					: ask(section === 'alerts' ? alerts : stopRecordQuery(section, stop)),
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
export function loadStopRecord(
	scope: EnginePeriod,
	stop: string,
	only?: undefined,
	identity?: Promise<EntityIdentity>,
): StopRecord;
export function loadStopRecord(
	scope: EnginePeriod,
	stop: string,
	only?: ReadonlySet<string>,
	identity?: Promise<EntityIdentity>,
) {
	return readStopRecord(scope, stop, only, identity);
}
